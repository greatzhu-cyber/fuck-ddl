use serde::{Deserialize, Serialize};
use tauri::{
    webview::PageLoadEvent, AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
};
use url::Url;

const ZJU_WINDOW_LABEL: &str = "zju-source";
const ZJU_HOME_URL: &str = "https://courses.zju.edu.cn/user/index";
const ZJU_COURSES_URL: &str = "https://courses.zju.edu.cn/user/courses";
const MAX_PAYLOAD_BYTES: usize = 128 * 1024;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ZjuCourseSelection {
    course_id: String,
    course_title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    course_url: Option<String>,
    /// e.g. "2025-2026春夏" from the course list card.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    semester: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZjuSyncOptions {
    /// `tasks` = course summaries only (fast).
    /// `grades` = grades for the selected courses only.
    /// `courses` = course catalog from /user/courses only.
    mode: Option<String>,
    /// Required for grades mode — only these courses are opened.
    #[serde(default)]
    courses: Option<Vec<ZjuCourseSelection>>,
}

fn zju_sync_mode(raw: Option<&str>) -> &'static str {
    match raw {
        Some("grades") | Some("grades-v1") => "grades",
        Some("courses") => "courses",
        _ => "tasks",
    }
}

fn grade_course_url(course_id: &str) -> String {
    format!("https://courses.zju.edu.cn/course/{course_id}/score#/")
}

fn sanitized_course_selection(course: &ZjuCourseSelection) -> Option<ZjuCourseSelection> {
    let course_id = course.course_id.trim();
    let course_title = course.course_title.trim();
    if course_id.is_empty()
        || !course_id
            .chars()
            .all(|character| character.is_ascii_digit())
        || course_title.is_empty()
        || course_title.len() > 512
    {
        return None;
    }
    let course_url = course
        .course_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("https://courses.zju.edu.cn/course/{course_id}/content"));
    if !is_valid_course_url(&course_url, course_id) {
        return None;
    }
    let semester = course
        .semester
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 40)
        .map(str::to_string);
    Some(ZjuCourseSelection {
        course_id: course_id.to_string(),
        course_title: course_title.to_string(),
        course_url: Some(course_url),
        semester,
    })
}

fn zju_sync_url(options: Option<&ZjuSyncOptions>) -> Result<String, String> {
    let mode = zju_sync_mode(options.and_then(|value| value.mode.as_deref()));
    if mode == "grades" {
        let courses = options
            .and_then(|value| value.courses.as_ref())
            .into_iter()
            .flatten()
            .filter_map(sanitized_course_selection)
            .collect::<Vec<_>>();
        if let Some(first) = courses.first() {
            return Ok(grade_course_url(&first.course_id));
        }
    }
    let mut url = Url::parse(ZJU_COURSES_URL).map_err(|_| "zju-url-invalid".to_string())?;
    url.query_pairs_mut().append_pair("fuckddl-sync", mode);
    // Catalog starts on page 1 of the SPA list (pageIndex is 1-based on 学在浙大).
    if mode == "courses" {
        return Ok(format!("{}#/?pageIndex=1", url));
    }
    Ok(url.into())
}

const EXTRACT_SCRIPT: &str = r#"
(() => {
  if (window.top !== window) return;
  if (location.origin !== 'https://courses.zju.edu.cn') return;

  const TASK_QUEUE_KEY = 'fuckddl:zju:tasks:queue';
  const TASK_RESULTS_KEY = 'fuckddl:zju:tasks:results';
  const TASK_INDEX_KEY = 'fuckddl:zju:tasks:index';
  const TASK_ACTIVITY_QUEUE_KEY = 'fuckddl:zju:tasks:activity-queue';
  const TASK_ACTIVITY_INDEX_KEY = 'fuckddl:zju:tasks:activity-index';
  const TASK_SCAN_STATS_KEY = 'fuckddl:zju:tasks:scan-stats';
  const TASK_CATALOG_ACCUM_KEY = 'fuckddl:zju:tasks:catalog-accum';
  const TASK_CATALOG_PAGE_KEY = 'fuckddl:zju:tasks:catalog-page';
  const TASK_CATALOG_WAIT_KEY = 'fuckddl:zju:tasks:catalog-wait';
  const TASK_CATALOG_FP_KEY = 'fuckddl:zju:tasks:catalog-fp';
  const GRADE_QUEUE_KEY = 'fuckddl:zju:grades:queue';
  const GRADE_RESULTS_KEY = 'fuckddl:zju:grades:results';
  const GRADE_INDEX_KEY = 'fuckddl:zju:grades:index';
  const MODE_KEY = 'fuckddl:zju:mode';
  const COURSE_SEED_KEY = 'fuckddl:zju:course-seed';
  const COURSES_ACCUM_KEY = 'fuckddl:zju:courses-accum';
  const COURSES_PAGE_KEY = 'fuckddl:zju:courses-page';
  // Keep crawls bounded to avoid WebView2 OOM / long hangs.
  const MAX_COURSES = 20;
  const MAX_TASK_COURSES = 120;
  const MAX_CATALOG_COURSES = 120;
  const MAX_CATALOG_PAGES = 15;
  // Grades must never open homework detail pages.
  const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
  const readJson = (key, fallback) => {
    try {
      return JSON.parse(sessionStorage.getItem(key) || '') || fallback;
    } catch {
      return fallback;
    }
  };
  const readMode = () => {
    const mode = sessionStorage.getItem(MODE_KEY);
    if (mode === 'grades' || mode === 'courses') return mode;
    return 'tasks';
  };
  const taskCourseUrl = (course) => {
    const id = String(course?.courseId || '').trim();
    return id ? `${location.origin}/course/${id}/homework` : '';
  };
  const gradeCourseUrl = (course) => {
    const id = String(course?.courseId || '').trim();
    return id ? `${location.origin}/course/${id}/score#/` : '';
  };
  const isScoreRoute = () => /\/score(?:\/|$)/.test(location.pathname);
  // Serialize ALL top-level location.href writes. Progress uses a cancelled
  // fuckddl-sync navigation; if it races with a real course hop, WebView2
  // keeps the old page while INDEX already advanced → task crawl freezes
  // after "下一门课" with no further logs (see course 1 → 2 hang).
  let hrefQueue = Promise.resolve();
  const enqueueHref = (url) => {
    const target = String(url || '');
    if (!target) return hrefQueue;
    hrefQueue = hrefQueue
      .then(
        () =>
          new Promise((resolve) => {
            try {
              location.href = target;
            } catch (_) {}
            // Bridge signals are cancelled in Rust (page stays put). Yield so
            // the cancel settles before the next real navigation.
            const bridge = target.indexOf('fuckddl-sync://') === 0;
            setTimeout(resolve, bridge ? 45 : 0);
          })
      )
      .catch(() => {});
    return hrefQueue;
  };
  // Live debug lines for the desktop UI (navigation is cancelled in Rust).
  const progress = (message) => {
    const text = String(message || '').slice(0, 240);
    try {
      const encoded = encodeURIComponent(JSON.stringify({ message: text }));
      enqueueHref(`fuckddl-sync://zju-progress?payload=${encoded}`);
    } catch (_) {}
  };
  /** Real page navigation (course hop / catalog). Queued after any progress. */
  const go = (url) => {
    if (!url) return;
    enqueueHref(url);
  };
  const signal = (host, value) => {
    if (value === undefined) {
      enqueueHref(`fuckddl-sync://${host}`);
      return;
    }
    // Compact payload — huge URLs crash WebView2.
    const compact = (Array.isArray(value) ? value : []).slice(0, 120).map((item) => ({
      courseId: item.courseId,
      courseTitle: String(item.courseTitle || '').slice(0, 120),
      courseUrl: item.courseUrl,
      ...(item.semester ? { semester: String(item.semester).slice(0, 40) } : {}),
      ...(item.activityId ? { activityId: item.activityId } : {}),
      ...(item.activityUrl ? { activityUrl: item.activityUrl } : {}),
      title: String(item.title || item.courseTitle || '').slice(0, 160),
      text: String(item.text || item.semester || '').slice(0, 400),
      ...(item.score !== undefined ? { score: item.score } : {}),
      ...(item.maxScore !== undefined ? { maxScore: item.maxScore } : {}),
      ...(item.gradeStatus ? { gradeStatus: item.gradeStatus } : {})
    }));
    let encoded = encodeURIComponent(JSON.stringify(compact));
    if (encoded.length > 100000) {
      const smaller = compact.map((item) => ({
        ...item,
        text: String(item.text || '').slice(0, 160),
        courseTitle: String(item.courseTitle || '').slice(0, 80)
      })).slice(0, 60);
      encoded = encodeURIComponent(JSON.stringify(smaller));
    }
    if (encoded.length > 120000) {
      enqueueHref('fuckddl-sync://zju-extract-failed');
      return;
    }
    // Finish must go through the href queue so a progress line cannot
    // overwrite the final payload navigation.
    enqueueHref(`fuckddl-sync://${host}?payload=${encoded}`);
  };
  const clearTaskScan = () => {
    sessionStorage.removeItem(TASK_QUEUE_KEY);
    sessionStorage.removeItem(TASK_RESULTS_KEY);
    sessionStorage.removeItem(TASK_INDEX_KEY);
    sessionStorage.removeItem(TASK_ACTIVITY_QUEUE_KEY);
    sessionStorage.removeItem(TASK_ACTIVITY_INDEX_KEY);
    sessionStorage.removeItem(TASK_SCAN_STATS_KEY);
    sessionStorage.removeItem(TASK_CATALOG_ACCUM_KEY);
    sessionStorage.removeItem(TASK_CATALOG_PAGE_KEY);
    sessionStorage.removeItem(TASK_CATALOG_WAIT_KEY);
    sessionStorage.removeItem(TASK_CATALOG_FP_KEY);
  };
  const clearGradeScan = () => {
    sessionStorage.removeItem(GRADE_QUEUE_KEY);
    sessionStorage.removeItem(GRADE_RESULTS_KEY);
    sessionStorage.removeItem(GRADE_INDEX_KEY);
    try {
      Object.keys(sessionStorage).forEach((key) => {
        if (key.startsWith('fuckddl:zju:grades:')) sessionStorage.removeItem(key);
      });
    } catch (_) {}
  };
  const clearCatalogScan = () => {
    sessionStorage.removeItem(MODE_KEY);
    sessionStorage.removeItem(COURSE_SEED_KEY);
    sessionStorage.removeItem(COURSES_ACCUM_KEY);
    sessionStorage.removeItem(COURSES_PAGE_KEY);
    sessionStorage.removeItem('fuckddl:zju:courses-wait');
    sessionStorage.removeItem('fuckddl:zju:courses-phase');
    sessionStorage.removeItem('fuckddl:zju:courses-fp');
    sessionStorage.removeItem('fuckddl:zju:courses-method');
    sessionStorage.removeItem('fuckddl:zju:courses-size');
  };
  const clearScan = () => {
    clearTaskScan();
    clearGradeScan();
    clearCatalogScan();
    [
      'fuckddl:zju:queue',
      'fuckddl:zju:results',
      'fuckddl:zju:index',
      'fuckddl:zju:activity-queue',
      'fuckddl:zju:activity-index'
    ].forEach((key) => sessionStorage.removeItem(key));
  };
  const fail = () => {
    clearScan();
    signal('zju-extract-failed');
  };
  const finishTasks = (results) => {
    const queue = readJson(TASK_QUEUE_KEY, []);
    const stats = readJson(TASK_SCAN_STATS_KEY, { confirmed: 0, uncertain: 0 });
    if (
      queue.length > 0 &&
      (Number(stats.uncertain || 0) > 0 ||
        ((results || []).length === 0 && Number(stats.confirmed || 0) === 0))
    ) {
      progress(
        `任务：存在未形成可确认快照的课程（确认${stats.confirmed || 0}/不确定${stats.uncertain || 0}），保留已有任务并报告读取失败`
      );
      clearScan();
      signal('zju-extract-failed');
      return;
    }
    clearScan();
    signal('zju', (results || []).map((item) => {
      const { gradeStatus, score, maxScore, ...taskFields } = item || {};
      return taskFields;
    }));
  };
  const finishGrades = (results) => {
    clearScan();
    signal('zju', (results || []).map((item) => {
      const { activityId, activityUrl, ...rest } = item || {};
      return rest;
    }));
  };
  const finishCourses = (results) => {
    clearScan();
    signal('zju-courses', results || []);
  };
  const afterDomReady = (callback) => {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', callback, { once: true });
    } else {
      callback();
    }
  };

  const collectCourseCards = () => {
    const seen = new Set();
    const out = [];
    const junkTitle = (title) =>
      !title ||
      title.length < 2 ||
      title.length > 120 ||
      /^\d+$/.test(title) ||
      /^(课程(内容|主页)?|进入|更多|学习|作业|我的课程|首页|查看|加入课程|未分类|展开|收起)$/.test(title);

    const cleanTitle = (raw) =>
      normalize(raw)
        .replace(/\s*更多\s*$/g, '')
        .replace(/\s*20\d{2}\s*[-–]\s*20\d{2}.*/g, '')
        .replace(/\s*开课[:：].*$/g, '')
        .replace(/\s*授课班级[:：].*$/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    const semesterFromText = (raw) => {
      const text = String(raw || '');
      // Card right side: 2025-2026春夏 (problem / 课程列表 screenshots)
      const match = text.match(/(20\d{2})\s*[-–—]\s*(20\d{2})\s*([春夏秋冬]{1,4})/);
      if (!match) return '';
      return `${match[1]}-${match[2]}${match[3]}`;
    };

    const semesterFromNode = (node) => {
      if (!node) return '';
      // Prefer a leaf whose entire text is exactly the semester badge.
      const leaves = Array.from(node.querySelectorAll('*')).concat(node);
      for (const el of leaves) {
        if (el.children && el.children.length > 0 && el !== node) continue;
        const t = normalize(el.textContent);
        if (/^20\d{2}-20\d{2}[春夏秋冬]{1,4}$/.test(t)) return t;
        const m = semesterFromText(t);
        if (m && t.length <= 20) return m;
      }
      return semesterFromText(node.innerText || node.textContent);
    };

    const addCourse = (courseId, rawTitle, rawSemester) => {
      const id = String(courseId || '').trim();
      let title = cleanTitle(rawTitle);
      // Avoid treating semester badge as title.
      if (/^20\d{2}-20\d{2}/.test(title)) return;
      if (!id || !/^\d+$/.test(id) || junkTitle(title)) return;
      const rawSem = String(rawSemester || '').replace(/\s+/g, '').replace('–', '-').replace('—', '-');
      const semester =
        semesterFromText(rawSemester) ||
        (/^20\d{2}-20\d{2}[春夏秋冬]{1,4}$/.test(rawSem) ? rawSem : '') ||
        '未知学期';
      const existing = out.find((item) => item.courseId === id);
      if (existing) {
        if (existing.semester === '未知学期' && semester !== '未知学期') {
          existing.semester = semester;
        }
        if (
          (existing.courseTitle.startsWith('课程 ') ||
            existing.courseTitle.length < 4) &&
          !title.startsWith('课程 ')
        ) {
          existing.courseTitle = title.slice(0, 120);
        }
        return;
      }
      seen.add(id);
      out.push({
        courseId: id,
        courseTitle: title.slice(0, 120),
        courseUrl: `${location.origin}/course/${id}/content`,
        semester
      });
    };

    const cardOf = (node) =>
      node?.closest?.(
        '[class*="course"], li, article, tr, section, .item, .card, [class*="row"], [class*="list"] > div, [class*="list"] > li'
      ) || node?.parentElement || null;

    const titleFrom = (node) => {
      if (!node) return { title: '', semester: '' };
      const card = cardOf(node);
      const cardText = card ? (card.innerText || card.textContent || '') : '';
      const semester = semesterFromNode(card) || semesterFromText(cardText);
      const candidates = [
        node.getAttribute?.('title'),
        node.getAttribute?.('aria-label'),
        node.querySelector?.('h1, h2, h3, h4, strong, .course-name, .name, .title, [class*="course-name"], [class*="course-title"], [class*="courseName"]')?.textContent,
        card?.querySelector?.('h1, h2, h3, h4, strong, .course-name, .name, .title, [class*="course-name"], [class*="course-title"], [class*="courseName"]')?.textContent,
      ];
      for (const candidate of candidates) {
        const cleaned = cleanTitle(candidate);
        if (!junkTitle(cleaned) && !/^20\d{2}-20\d{2}/.test(cleaned)) {
          return { title: cleaned, semester };
        }
      }
      // Card text often starts with the course name (see 学在浙大课程列表 screenshot).
      if (card) {
        const lines = String(card.innerText || cardText)
          .split(/\n+/)
          .map((line) => cleanTitle(line))
          .filter((line) =>
            !junkTitle(line) &&
            !/开课|授课|学院|学期|更多|页码|下一页|Go/.test(line) &&
            !/^20\d{2}-20\d{2}/.test(line) &&
            !/20\d{2}[-–—]20\d{2}/.test(line)
          );
        if (lines[0]) return { title: lines[0], semester };
      }
      return { title: cleanTitle(node.textContent), semester };
    };

    const idFromHref = (href) => {
      try {
        const match = new URL(href, location.origin).pathname.match(/^\/course\/(\d+)(?:\/|$)/);
        return match?.[1] || '';
      } catch {
        const match = String(href || '').match(/\/course\/(\d+)(?:\/|$)/);
        return match?.[1] || '';
      }
    };

    // Course list / home cards: any /course/<id> link (content optional).
    const anchors = Array.from(
      document.querySelectorAll(
        'a[href*="/course/"], a[ng-href*="/course/"], [href*="/course/"], [ng-href*="/course/"]'
      )
    );
    for (const link of anchors) {
      const href = link.getAttribute('href') || link.getAttribute('ng-href') || link.href || '';
      const id = idFromHref(href);
      if (!id) continue;
      const meta = titleFrom(link);
      addCourse(id, meta.title, meta.semester);
    }

    // Fallback: data attributes / angular course id bindings.
    const dataNodes = Array.from(
      document.querySelectorAll(
        '[data-course-id], [course-id], [ng-reflect-course-id], [ng-reflect-id]'
      )
    );
    for (const node of dataNodes) {
      const id =
        node.getAttribute('data-course-id') ||
        node.getAttribute('course-id') ||
        node.getAttribute('ng-reflect-course-id') ||
        (node.getAttribute('ng-reflect-id') || '').match(/^\d+$/)?.[0];
      if (!id) continue;
      const meta = titleFrom(node);
      addCourse(id, meta.title, meta.semester);
    }

    // Always merge HTML id scan — list pages often hide real links behind SPA handlers.
    {
      const html = document.body?.innerHTML || '';
      const re = /\/course\/(\d{4,})/g;
      let match;
      while ((match = re.exec(html)) && out.length < MAX_CATALOG_COURSES) {
        const id = match[1];
        if (seen.has(id)) continue;
        const slice = html.slice(Math.max(0, match.index - 240), match.index + 160);
        const textMatch = slice.match(/>([^<>]{2,60})</g);
        const guess = (textMatch || [])
          .map((part) => cleanTitle(part.replace(/^>|<$/g, '')))
          .find((part) => !junkTitle(part) && !/http|course|class|style|ng-|svg|path/i.test(part));
        addCourse(id, guess || `课程 ${id}`, semesterFromText(slice));
      }
    }

    // Card rows: title left + semester right "2025-2026春夏" (problem screenshot).
    {
      const rows = Array.from(document.querySelectorAll('li, article, tr, section, div'));
      for (const row of rows) {
        if (out.length >= MAX_CATALOG_COURSES) break;
        const text = row.innerText || row.textContent || '';
        if (text.length < 8 || text.length > 320) continue;
        const semester = semesterFromNode(row) || semesterFromText(text);
        if (!semester) continue;
        const idMatch = (row.innerHTML || '').match(/\/course\/(\d{4,})/);
        if (!idMatch) continue;
        const titleLine = String(text)
          .split(/\n+/)
          .map((line) => cleanTitle(line))
          .find((line) =>
            !junkTitle(line) &&
            !/开课|授课|更多|学院|页码|下一页|Go/.test(line) &&
            !/^20\d{2}-20\d{2}/.test(line) &&
            !/20\d{2}[-–—]20\d{2}/.test(line)
          );
        if (titleLine) addCourse(idMatch[1], titleLine, semester);
      }
    }

    return out;
  };

  const scrollCatalogToPager = () => {
    // User: must scroll to bottom before the page-number bar is usable.
    try {
      const roots = [
        document.scrollingElement,
        document.documentElement,
        document.body,
        ...Array.from(
          document.querySelectorAll(
            '.main, main, [class*="content"], [class*="scroll"], [class*="list"], [class*="table"]'
          )
        )
      ];
      for (const el of roots) {
        if (!el) continue;
        try {
          el.scrollTop = el.scrollHeight || 99999;
        } catch (_) {}
      }
      window.scrollTo(0, Math.max(
        document.body?.scrollHeight || 0,
        document.documentElement?.scrollHeight || 0
      ));
    } catch (_) {}
  };

  const setInputValue = (input, value) => {
    try {
      const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      if (desc && desc.set) desc.set.call(input, value);
      else input.value = value;
    } catch (_) {
      input.value = value;
    }
    for (const type of ['input', 'change', 'blur']) {
      input.dispatchEvent(new Event(type, { bubbles: true }));
    }
  };

  const hardClick = (node) => {
    if (!node) return false;
    try { node.scrollIntoView?.({ block: 'center', inline: 'center' }); } catch (_) {}
    try {
      const opts = { bubbles: true, cancelable: true, view: window, buttons: 1 };
      for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
        node.dispatchEvent(new MouseEvent(type, opts));
      }
      if (typeof node.click === 'function') node.click();
      return true;
    } catch (_) {
      return false;
    }
  };

  const pagerRoot = () => {
    // Footer bar containing 页码 + Go (翻页问题 screenshot).
    const go = Array.from(document.querySelectorAll('button, a, span, input'))
      .find((el) => normalize(el.textContent || el.value || '') === 'Go');
    if (go) {
      return go.closest('div, section, nav, form, ul, footer')?.parentElement
        || go.closest('div, section, nav, form')
        || document.body;
    }
    const label = Array.from(document.querySelectorAll('span, label, div'))
      .find((el) => normalize(el.textContent) === '页码');
    return label?.closest('div, section, nav, form')?.parentElement || document.body;
  };

  const ownText = (el) =>
    normalize(
      Array.from(el.childNodes || [])
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent)
        .join('') || (el.children && el.children.length === 0 ? el.textContent : '')
    );

  /**
   * 多项 screenshot: footer is  `1 2 3 下一页 | 10▼ 页 | 页码 [1] Go`
   * Find the "10" expander for 项/页 (page size), not the page-number chips.
   */
  const findItemsPerPageTrigger = () => {
    const root = pagerRoot();
    const go = Array.from(document.querySelectorAll('button, a, span, input'))
      .find((el) => normalize(el.textContent || el.value || '') === 'Go');
    const footer =
      (go && (go.closest('div, section, nav, form')?.parentElement || go.parentElement)) ||
      root ||
      document.body;

    // Native select near pager
    for (const sel of Array.from(footer.querySelectorAll('select')).concat(
      Array.from(document.querySelectorAll('select'))
    )) {
      const rect = sel.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.top < window.innerHeight * 0.35) continue;
      const nums = Array.from(sel.options)
        .map((o) => Number(String(o.value || o.textContent).replace(/[^\d]/g, '')))
        .filter((n) => Number.isFinite(n) && n >= 10);
      if (nums.length >= 2) return { type: 'select', el: sel, nums };
    }

    // Custom control: leaf/near-leaf showing "10", sitting beside "页" and near "页码/Go"
    const nodes = Array.from(footer.querySelectorAll('div, span, button, a, i, em'));
    const scored = [];
    for (const el of nodes) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.top < window.innerHeight * 0.4) continue;
      const own = ownText(el);
      const full = normalize(el.textContent);
      // Match "10" or "10 页" / "10项/页" style
      const isTen =
        own === '10' ||
        full === '10' ||
        /^10\s*项?\/?页$/.test(full) ||
        /^10\s*页$/.test(full);
      if (!isTen) continue;
      // Must be near 页 / 页码 / Go in the same footer strip
      const parentText = normalize(el.parentElement?.innerText || el.parentElement?.textContent || '');
      const grandText = normalize(el.parentElement?.parentElement?.innerText || '');
      const ctx = parentText + ' ' + grandText;
      if (!/页|页码|Go|下一页/.test(ctx)) continue;
      // Prefer controls that also look like a dropdown (caret / arrow / select)
      const cls = String(el.className || '') + ' ' + String(el.parentElement?.className || '');
      let score = 10;
      if (/select|dropdown|caret|arrow|ant-select|ui-select/i.test(cls)) score += 5;
      if (/页/.test(parentText)) score += 3;
      if (own === '10') score += 2;
      // Deprioritize pure page-number chips (usually farther left, no "页" immediately)
      if (/^[123]$/.test(full)) score -= 20;
      scored.push({ el, score, rect });
    }
    scored.sort((a, b) => b.score - a.score || b.rect.top - a.rect.top);
    if (scored[0]) return { type: 'dropdown', el: scored[0].el, nums: [10, 20, 50, 100] };

    // Fallback: any bottom-of-page "10" next to the word 页
    for (const el of Array.from(document.querySelectorAll('div, span, button, a'))) {
      const rect = el.getBoundingClientRect();
      if (rect.top < window.innerHeight * 0.55 || rect.width === 0) continue;
      if (ownText(el) !== '10' && normalize(el.textContent) !== '10') continue;
      const sib = normalize(
        (el.nextElementSibling?.textContent || '') +
          (el.parentElement?.textContent || '')
      );
      if (/页/.test(sib)) return { type: 'dropdown', el, nums: [10, 20, 50, 100] };
    }
    return null;
  };

  /** After the 项/页 menu is open, click the largest size option. */
  const pickLargestPageSizeOption = () => {
    // Options may render in a portal at document body level.
    const candidates = Array.from(
      document.querySelectorAll('li, div, span, a, option, [role="option"]')
    );
    const opts = [];
    for (const el of candidates) {
      const t = ownText(el) || normalize(el.textContent);
      if (!/^(10|20|50|100|200)$/.test(t)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      // Visible dropdown options often overlay mid/lower screen
      opts.push({ el, n: Number(t), top: rect.top });
    }
    if (opts.length === 0) return 0;
    opts.sort((a, b) => b.n - a.n);
    // Prefer the largest that is not the currently-selected-only singleton
    for (const opt of opts) {
      if (opt.n <= 10) continue;
      if (hardClick(opt.el)) return opt.n;
    }
    return 0;
  };

  /**
   * Open the 项/页 size control (多项 screenshot). Returns:
   *  { ok:true, via:'select', size } | { ok:true, via:'opened' } | { ok:false }
   */
  const openItemsPerPageMenu = () => {
    scrollCatalogToPager();
    const hit = findItemsPerPageTrigger();
    if (!hit) return { ok: false, reason: '未找到 项/页 展开符' };
    if (hit.type === 'select') {
      const best = Math.max(...hit.nums.filter((n) => n > 10), 0);
      if (!best) return { ok: false, reason: 'select 无更大条数' };
      const sel = hit.el;
      for (const opt of sel.options) {
        const n = Number(String(opt.value || opt.textContent).replace(/[^\d]/g, ''));
        if (n === best) {
          sel.selectedIndex = opt.index;
          break;
        }
      }
      sel.value = String(best);
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, via: 'select', size: best };
    }
    // Click the "10 ▼" expander
    const trigger = hit.el.closest('div, button, a, span') || hit.el;
    if (!hardClick(trigger) && !hardClick(hit.el)) {
      return { ok: false, reason: '点击 项/页 展开符失败' };
    }
    // Also click a caret icon inside the same control if present
    const caret = trigger.querySelector?.('i, .caret, [class*="arrow"], [class*="down"]');
    if (caret) hardClick(caret);
    return { ok: true, via: 'opened' };
  };

  /** Flip catalog page. Prefer page-number chip in pager, then 页码+Go, then hard reload. */
  const goToCatalogPage = (pageNum) => {
    scrollCatalogToPager();
    const root = pagerRoot();

    // A) Click the numbered chip "2" / "3" inside the pager bar (not course titles).
    const chips = Array.from(root.querySelectorAll('a, button, li, span, div')).filter((el) => {
      const own = normalize(
        Array.from(el.childNodes)
          .filter((n) => n.nodeType === 3)
          .map((n) => n.textContent)
          .join('') || (el.children.length === 0 ? el.textContent : '')
      );
      if (own === String(pageNum)) return true;
      // li > a structure
      if (el.tagName === 'LI' || el.tagName === 'A') {
        return normalize(el.textContent) === String(pageNum) && normalize(el.textContent).length <= 3;
      }
      return false;
    });
    // Prefer elements near the bottom of the viewport
    chips.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
    if (chips[0] && hardClick(chips[0])) return `点击页码芯片 ${pageNum}`;

    // B) 下一页
    const nextBtn = Array.from(root.querySelectorAll('a, button, li, span'))
      .find((el) => {
        const t = normalize(el.textContent);
        return t === '下一页' || t === '下页' || t === '下一页>' || t.endsWith('下一页');
      });
    if (nextBtn && hardClick(nextBtn)) return '点击下一页';

    // C) 页码 input + Go (screenshot still shows 1 after failed soft sets — still try)
    const inputs = Array.from(root.querySelectorAll('input')).concat(
      Array.from(document.querySelectorAll('input'))
    );
    for (const input of inputs) {
      const ph = String(input.placeholder || '');
      if (/课程名称|搜索|search|Search/i.test(ph)) continue;
      const rect = input.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.top < window.innerHeight * 0.45) continue;
      try {
        input.focus();
        setInputValue(input, String(pageNum));
        // React/Angular often need InputEvent
        try {
          input.dispatchEvent(new InputEvent('input', { bubbles: true, data: String(pageNum), inputType: 'insertText' }));
        } catch (_) {}
        const go = Array.from((input.closest('div, form, section, li') || root).querySelectorAll(
          'button, a, span, input[type="button"], input[type="submit"]'
        )).find((el) => {
          const t = normalize(el.textContent || el.value || '');
          return t === 'Go' || t === 'GO' || t === '确定' || t === '跳转';
        });
        if (go && hardClick(go)) return `页码输入 ${pageNum} + Go`;
      } catch (_) {}
    }
    return 'hard-reload';
  };

  const catalogPageUrl = (pageNum, mode = readMode()) => {
    const base = `${location.origin}/user/courses`;
    // Keep task and course-catalog navigation in their own mode across hard reloads.
    const syncMode = mode === 'tasks' ? 'tasks' : 'courses';
    return `${base}?fuckddl-sync=${syncMode}&pageIndex=${pageNum}&page=${pageNum}&_t=${Date.now()}#/?pageIndex=${pageNum}`;
  };  const startTaskQueue = (courses) => {
    clearTaskScan();
    sessionStorage.setItem(TASK_QUEUE_KEY, JSON.stringify(courses));
    sessionStorage.setItem(TASK_RESULTS_KEY, '[]');
    sessionStorage.setItem(TASK_INDEX_KEY, '0');
    sessionStorage.setItem(TASK_ACTIVITY_QUEUE_KEY, '[]');
    sessionStorage.setItem(TASK_ACTIVITY_INDEX_KEY, '0');
    sessionStorage.setItem(TASK_SCAN_STATS_KEY, JSON.stringify({ confirmed: 0, uncertain: 0 }));
    if (courses.length === 0) return finishTasks([]);
    go(taskCourseUrl(courses[0]));
  };
  const startGradeQueue = (courses) => {
    clearGradeScan();
    sessionStorage.setItem(GRADE_QUEUE_KEY, JSON.stringify(courses));
    sessionStorage.setItem(GRADE_RESULTS_KEY, '[]');
    sessionStorage.setItem(GRADE_INDEX_KEY, '0');
    if (courses.length === 0) return finishGrades([]);
    go(gradeCourseUrl(courses[0]));
  };  const scanCourses = () => {
    const mode = readMode();
    // Grades: only crawl user-selected courses seeded by the desktop bridge.
    if (mode === 'grades') {
      const existing = readJson(GRADE_QUEUE_KEY, []);
      const idx = sessionStorage.getItem(GRADE_INDEX_KEY);
      // If mid-crawl we accidentally landed on 课程列表, do NOT reset — go back to current course.
      if (existing.length > 0 && idx !== null && sessionStorage.getItem(GRADE_RESULTS_KEY) !== null) {
        const course = existing[Number(idx) || 0];
        if (course && (course.courseUrl || course.courseId)) {
          progress(`成绩：误入列表页，返回当前课 ${course.courseTitle || course.courseId}`);
          go(gradeCourseUrl(course));
          return;
        }
      }
      const seed = readJson(COURSE_SEED_KEY, []).concat(existing)
        .filter((item, index, list) =>
          item?.courseId &&
          item?.courseTitle &&
          list.findIndex((other) => other.courseId === item.courseId) === index
        )
        .map((item) => ({
          ...item,
          courseUrl: gradeCourseUrl(item)
        }))
        .slice(0, MAX_COURSES);
      if (seed.length === 0) {
        progress('成绩：队列为空（未选课？），结束');
        finish([]);
        return;
      }
      progress(`成绩：准备读取 ${seed.length} 门课 · ${seed.map((c) => c.courseTitle).slice(0, 4).join('、')}`);
      startGradeQueue(seed);
      return;
    }
    let attempts = 0;
    const inspect = () => {
      const pageCourses = collectCourseCards();
      const pageReady = Boolean(
        document.querySelector('input[placeholder*="课程名称"]') ||
        Array.from(document.querySelectorAll('a')).some(
          (link) => normalize(link.textContent) === '我的课程'
        ) ||
        pageCourses.length > 0
      );
      if (!pageReady || (pageCourses.length === 0 && attempts < 20)) {
        attempts += 1;
        if (attempts < 40) {
          setTimeout(inspect, 400);
        } else {
          fail();
        }
        return;
      }

      if (mode === 'courses') {
        // Prefer hash pageIndex when present (1-based on 学在浙大).
        const hashPage = Number((location.hash.match(/pageIndex=(\d+)/) || [])[1] || 0);
        const storedPage = Number(sessionStorage.getItem(COURSES_PAGE_KEY) || '0');
        const page = hashPage || storedPage || 1;
        sessionStorage.setItem(COURSES_PAGE_KEY, String(page));
        const waitKey = 'fuckddl:zju:courses-wait';
        const phaseKey = 'fuckddl:zju:courses-phase';
        const fpKey = 'fuckddl:zju:courses-fp';
        const methodKey = 'fuckddl:zju:courses-method';
        const sizeKey = 'fuckddl:zju:courses-size';
        const waitCount = Number(sessionStorage.getItem(waitKey) || '0');
        const phase = sessionStorage.getItem(phaseKey) || 'size';
        const prevFp = sessionStorage.getItem(fpKey) || '';
        const fingerprint = pageCourses.map((c) => c.courseId).sort().join(',');
        const accumulated = readJson(COURSES_ACCUM_KEY, []);
        const seen = new Set(accumulated.map((item) => item.courseId));
        let newOnPage = 0;
        for (const course of pageCourses) {
          if (seen.has(course.courseId)) continue;
          seen.add(course.courseId);
          accumulated.push(course);
          newOnPage += 1;
          if (accumulated.length >= MAX_CATALOG_COURSES) break;
        }
        sessionStorage.setItem(COURSES_ACCUM_KEY, JSON.stringify(accumulated));
        const catalogPayload = () => accumulated.map((course) => ({
          ...course,
          title: course.courseTitle,
          text: course.semester || '未知学期',
          semester: course.semester || '未知学期'
        }));
        const semesterHint = (() => {
          const counts = {};
          for (const c of pageCourses) {
            const s = c.semester || '未知学期';
            counts[s] = (counts[s] || 0) + 1;
          }
          return Object.entries(counts).map(([k, v]) => `${k}×${v}`).join('，') || '无学期';
        })();
        const endCatalog = (reason) => {
          progress(`${reason} · 共${accumulated.length}门`);
          sessionStorage.removeItem(waitKey);
          sessionStorage.removeItem(phaseKey);
          sessionStorage.removeItem(fpKey);
          sessionStorage.removeItem(methodKey);
          sessionStorage.removeItem(sizeKey);
          finishCourses(catalogPayload());
        };

        // Phase size: 多项 screenshot — 滚到底 → 点「10▼ 项/页」→ 选更大条数.
        if (phase === 'size' || phase === 'size-open' || phase === 'size-pick' || phase === 'size-wait') {
          // Success: list grew beyond default 10
          if (
            (phase === 'size-wait' || phase === 'size-pick') &&
            (pageCourses.length > 10 ||
              (fingerprint && prevFp && fingerprint !== prevFp && pageCourses.length >= 10))
          ) {
            progress(`项/页已生效 · 本页 ${pageCourses.length} 门 · 进入采集`);
            sessionStorage.setItem(phaseKey, 'collect');
            sessionStorage.setItem(waitKey, '0');
            setTimeout(inspect, 200);
            return;
          }

          if (phase === 'size' || phase === 'size-open') {
            progress('滚到页面底部…');
            scrollCatalogToPager();
            sessionStorage.setItem(fpKey, fingerprint || 'empty');
            const opened = openItemsPerPageMenu();
            if (!opened.ok) {
              if (waitCount < 3) {
                sessionStorage.setItem(waitKey, String(waitCount + 1));
                progress(`${opened.reason || '未找到项/页'}，重试 (${waitCount + 1}/3)…`);
                setTimeout(inspect, 500);
                return;
              }
              progress(`${opened.reason || '未找到项/页展开符'}，回退翻页`);
              sessionStorage.setItem(sizeKey, 'skip');
              sessionStorage.setItem(phaseKey, 'collect');
              sessionStorage.setItem(waitKey, '0');
              setTimeout(inspect, 200);
              return;
            }
            if (opened.via === 'select') {
              progress(`项/页 select → ${opened.size}，等待列表刷新…`);
              sessionStorage.setItem(sizeKey, String(opened.size));
              sessionStorage.setItem(phaseKey, 'size-wait');
              sessionStorage.setItem(waitKey, '0');
              setTimeout(inspect, 900);
              return;
            }
            progress('已点击「项/页」展开符（10▼），等待菜单…');
            sessionStorage.setItem(phaseKey, 'size-pick');
            sessionStorage.setItem(waitKey, '0');
            setTimeout(inspect, 450);
            return;
          }

          if (phase === 'size-pick') {
            scrollCatalogToPager();
            const size = pickLargestPageSizeOption();
            if (size > 10) {
              progress(`选择 ${size} 项/页…`);
              sessionStorage.setItem(sizeKey, String(size));
              sessionStorage.setItem(phaseKey, 'size-wait');
              sessionStorage.setItem(waitKey, '0');
              setTimeout(inspect, 900);
              return;
            }
            // Menu not ready — reopen a few times
            if (waitCount < 5) {
              sessionStorage.setItem(waitKey, String(waitCount + 1));
              progress(`菜单未出现可选项，再点展开符 (${waitCount + 1}/5)…`);
              openItemsPerPageMenu();
              setTimeout(inspect, 500);
              return;
            }
            progress('无法选择更大项/页，回退翻页');
            sessionStorage.setItem(sizeKey, 'skip');
            sessionStorage.setItem(phaseKey, 'collect');
            sessionStorage.setItem(waitKey, '0');
            setTimeout(inspect, 200);
            return;
          }

          // size-wait
          if (waitCount < 8) {
            sessionStorage.setItem(waitKey, String(waitCount + 1));
            progress(`等待项/页生效… (${waitCount + 1}/8) · 本页仍 ${pageCourses.length} 门`);
            setTimeout(inspect, 500);
            return;
          }
          progress(`项/页可能未生效（仍 ${pageCourses.length} 门/页），回退翻页`);
          sessionStorage.setItem(phaseKey, 'collect');
          sessionStorage.setItem(waitKey, '0');
          setTimeout(inspect, 200);
          return;
        }

        if (phase === 'wait-turn') {
          // Waiting for SPA list to actually change after flipping.
          if (fingerprint && fingerprint !== prevFp && pageCourses.length > 0) {
            progress(`翻页成功 → 第${page}页 · 本页${pageCourses.length}门 · 新增${newOnPage} · 累计${accumulated.length} · ${semesterHint}`);
            sessionStorage.setItem(phaseKey, 'collect');
            sessionStorage.setItem(waitKey, '0');
            sessionStorage.removeItem(methodKey);
            setTimeout(inspect, 250);
            return;
          }
          // Soft click failed: one hard reload attempt, then give up and KEEP what we have.
          if (waitCount === 3 && sessionStorage.getItem(methodKey) !== 'hard-reload') {
            progress(`软翻页无响应，强制跳转 pageIndex=${page} …`);
            sessionStorage.setItem(methodKey, 'hard-reload');
            sessionStorage.setItem(waitKey, String(waitCount + 1));
            go(catalogPageUrl(page));
            return;
          }
          if (waitCount < 8) {
            progress(`等待第${page}页加载… (${waitCount + 1}/8) · 累计${accumulated.length}`);
            sessionStorage.setItem(waitKey, String(waitCount + 1));
            if (waitCount === 1) {
              scrollCatalogToPager();
              goToCatalogPage(page);
            }
            setTimeout(inspect, 550);
            return;
          }
          // Critical: still write the courses already accumulated (e.g. 23 after 100项/页).
          endCatalog(
            `第${page}页未加载到新课，停止翻页并写入已采集的 ${accumulated.length} 门`
          );
          return;
        }

        progress(`读取第${page}页 · 本页${pageCourses.length}门 · 新增${newOnPage} · 累计${accumulated.length} · ${semesterHint}`);

        if (accumulated.length >= MAX_CATALOG_COURSES || page >= MAX_CATALOG_PAGES) {
          endCatalog('达到页数/门数上限，结束课程列表');
          return;
        }
        if (pageCourses.length === 0 && waitCount < 8) {
          sessionStorage.setItem(waitKey, String(waitCount + 1));
          progress(`第${page}页尚无卡片，等待渲染… (${waitCount + 1}/8)`);
          setTimeout(inspect, 400);
          return;
        }
        if (page > 1 && newOnPage === 0 && pageCourses.length > 0) {
          endCatalog(`第${page}页无新增课程（可能与上页重复），结束`);
          return;
        }

        // Key fix (调试 screenshot): after 项/页 → 100, only page "1" remains and
        // 23 courses already fit. Do NOT keep flipping — finish and write catalog.
        const configuredSize = Number(sessionStorage.getItem(sizeKey));
        if (
          Number.isFinite(configuredSize) &&
          configuredSize > 10 &&
          pageCourses.length > 0 &&
          pageCourses.length < configuredSize
        ) {
          endCatalog(
            `项/页=${configuredSize} 且本页仅 ${pageCourses.length} 门，已全部收齐，写入本地`
          );
          return;
        }

        scrollCatalogToPager();
        const root = pagerRoot();
        // Real next-page chip only (avoid false "2" from course titles / dates).
        const nextPageLabels = Array.from(root.querySelectorAll('a, button, li, span'))
          .filter((el) => {
            const t = ownText(el) || normalize(el.textContent);
            if (t === '下一页' || t === '下页') return true;
            if (t !== String(page + 1) || t.length > 2) return false;
            const rect = el.getBoundingClientRect();
            // Pager chips sit on the bottom strip near 页码/Go
            return rect.top > window.innerHeight * 0.55 && rect.width > 0 && rect.width < 80;
          });
        const hasNextChip = nextPageLabels.length > 0;

        if (!hasNextChip && accumulated.length > 0) {
          endCatalog(`无下一页控件，单页收齐 ${accumulated.length} 门，写入本地`);
          return;
        }
        sessionStorage.setItem(waitKey, '0');

        const nextPage = page + 1;
        progress(`滚到底部以露出翻页栏…（准备第${nextPage}页）`);
        scrollCatalogToPager();

        setTimeout(() => {
          scrollCatalogToPager();
          const method = goToCatalogPage(nextPage);
          progress(`翻页… ${method} · 目标第${nextPage}页 · 当前累计${accumulated.length}`);
          sessionStorage.setItem(fpKey, fingerprint || prevFp || 'empty');
          sessionStorage.setItem(COURSES_PAGE_KEY, String(nextPage));
          sessionStorage.setItem(phaseKey, 'wait-turn');
          sessionStorage.setItem(waitKey, '0');
          sessionStorage.setItem(methodKey, method);
          try { location.hash = `#/?pageIndex=${nextPage}`; } catch (_) {}
          if (method === 'hard-reload') {
            progress(`未点到翻页控件，强制 location 跳转 pageIndex=${nextPage}`);
            sessionStorage.setItem(methodKey, 'hard-reload');
            go(catalogPageUrl(nextPage));
            return;
          }
          setTimeout(scanCourses, 1100);
        }, 500);
        return;
      }

      // ===== TASKS mode: build course queue from every 我的课程 page =====
      if (mode === 'tasks') {
        // Mid-crawl: if we bounced back to the list, resume the current course.
        const existing = readJson(TASK_QUEUE_KEY, []);
        const idxRaw = sessionStorage.getItem(TASK_INDEX_KEY);
        if (
          existing.length > 0 &&
          idxRaw !== null &&
          sessionStorage.getItem(TASK_RESULTS_KEY) !== null
        ) {
          const course = existing[Number(idxRaw) || 0];
          if (course && (course.courseId || course.courseUrl)) {
            progress(
              `任务：误入列表页，返回当前课 (${Number(idxRaw) + 1}/${existing.length}) ${course.courseTitle || course.courseId}`
            );
            go(taskCourseUrl(course));
            return;
          }
        }

        // The task importer must walk the same paginated catalog the user sees.
        // Do not start the homework queue until every catalog page has been read.
        const hashPage = Number((location.hash.match(/pageIndex=(\d+)/) || [])[1] || 0);
        const storedPage = Number(sessionStorage.getItem(TASK_CATALOG_PAGE_KEY) || '0');
        const page = hashPage || storedPage || 1;
        const waitCount = Number(sessionStorage.getItem(TASK_CATALOG_WAIT_KEY) || '0');
        const previousFingerprint = sessionStorage.getItem(TASK_CATALOG_FP_KEY) || '';
        const fingerprint = pageCourses.map((c) => c.courseId).sort().join(',');
        const accumulated = readJson(TASK_CATALOG_ACCUM_KEY, []);
        const seen = new Set(accumulated.map((item) => item.courseId));
        let newOnPage = 0;
        for (const course of pageCourses) {
          if (seen.has(course.courseId)) continue;
          seen.add(course.courseId);
          accumulated.push(course);
          newOnPage += 1;
          if (accumulated.length >= MAX_CATALOG_COURSES) break;
        }
        sessionStorage.setItem(TASK_CATALOG_ACCUM_KEY, JSON.stringify(accumulated));

        const finishTaskCatalog = (reason) => {
          const courses = accumulated
            .slice(0, MAX_TASK_COURSES)
            .map((course) => ({ ...course, courseUrl: taskCourseUrl(course) }));
          progress(`${reason} · 共${courses.length}门，开始逐课扫描…`);
          startTaskQueue(courses);
        };

        // A hard navigation can briefly show the previous SPA page. Wait for
        // the fingerprint to change before accepting page N as a real page.
        if (page > 1 && fingerprint && previousFingerprint && fingerprint === previousFingerprint) {
          if (waitCount < 8) {
            sessionStorage.setItem(TASK_CATALOG_WAIT_KEY, String(waitCount + 1));
            progress(`任务：等待第${page}页课程列表刷新… (${waitCount + 1}/8) · 已收集${accumulated.length}门`);
            if (waitCount === 2) go(catalogPageUrl(page, 'tasks'));
            setTimeout(inspect, 500);
            return;
          }
          if (accumulated.length > 0) {
            finishTaskCatalog(`任务：第${page}页未刷新，停止翻页并写入已收集课程`);
          } else {
            fail();
          }
          return;
        }

        if (pageCourses.length === 0) {
          if (waitCount < 8) {
            sessionStorage.setItem(TASK_CATALOG_WAIT_KEY, String(waitCount + 1));
            progress(`任务：第${page}页尚无课程卡片，等待渲染… (${waitCount + 1}/8)`);
            setTimeout(inspect, 400);
            return;
          }
          if (accumulated.length > 0) {
            finishTaskCatalog(`任务：第${page}页为空，已收齐课程目录`);
          } else {
            fail();
          }
          return;
        }

        progress(`任务：读取课程第${page}页 · 本页${pageCourses.length}门 · 新增${newOnPage} · 累计${accumulated.length}`);
        if (accumulated.length >= MAX_CATALOG_COURSES || page >= MAX_CATALOG_PAGES) {
          finishTaskCatalog('任务：达到课程目录上限');
          return;
        }

        sessionStorage.setItem(TASK_CATALOG_PAGE_KEY, String(page + 1));
        sessionStorage.setItem(TASK_CATALOG_FP_KEY, fingerprint || previousFingerprint || 'empty');
        sessionStorage.setItem(TASK_CATALOG_WAIT_KEY, '0');
        progress(`任务：课程目录翻页 → 第${page + 1}页`);
        go(catalogPageUrl(page + 1, 'tasks'));
        return;
      }
    };
    inspect();
  };
  const activityIdFromUrl = (value) => {
    try {
      const url = new URL(value, location.origin);
      const hashMatch = url.hash.match(/#\/(?:[^/]+\/)*(\d+)(?:[/?#]|$)/);
      const pathMatch = url.pathname.match(/\/learning-activity\/(?:full-screen\/)?(\d+)(?:\/|$)/);
      return hashMatch?.[1] || pathMatch?.[1] || '';
    } catch {
      return '';
    }
  };
  const activityLink = (container, course) => {
    const links = [
      container.matches?.('a[href]') ? container : null,
      container.closest?.('a[href]'),
      ...Array.from(container.querySelectorAll('a[href]'))
    ].filter(Boolean);
    const direct = links.find((link) => {
      const href = link.getAttribute('href') || '';
      return /learning-activity|full-screen|#\/\d+/.test(href);
    });
    if (direct) {
      try {
        const url = new URL(direct.href, location.origin);
        const activityId = activityIdFromUrl(url.href);
        if (activityId) return { activityId, activityUrl: url.href };
      } catch {
        // Ignore malformed links supplied by the page and try the HTML fallback.
      }
    }
    const html = container.outerHTML || '';
    const idMatch = html.match(/(?:#\/|activity(?:Id|-id)[=:\"'\s]+)(\d{4,})/i);
    if (!idMatch) return {};
    const activityId = idMatch[1];
    return {
      activityId,
      activityUrl: `${location.origin}/course/${course.courseId}/learning-activity/full-screen#/${activityId}`
    };
  };
  const numberValue = (raw) => {
    const value = Number(String(raw ?? '').replace(/,/g, ''));
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  };
  const TASK_ROW_SELECTOR =
    '[ng-repeat="homework in homeworkList track by homework.id"]';
  const nodeIsVisible = (node) => {
    if (!node || node.classList?.contains('ng-hide')) return false;
    try {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0
      );
    } catch {
      return false;
    }
  };
  const taskPageLoading = (controller) =>
    Array.from(
      (controller || document).querySelectorAll(
        '[ng-show="loadingFullPage"], [ng-show="loading"], .loading-bg-mask, .loading-gif, .loading-spinner'
      )
    ).some(nodeIsVisible);
  const taskPageEmptyNode = (controller) =>
    Array.from(
      (controller || document).querySelectorAll(
        '[ng-if*="homeworkList.length == 0"], [ng-if*="homeworkList.length === 0"], [ng-show*="homeworkList.length == 0"]'
      )
    ).find(nodeIsVisible);
  const cleanTaskTitle = (raw, fullText) => {
    let title = normalize(raw);
    // Never accept pure deadline labels as titles (读取问题 screenshot).
    if (!title || /^(结束时间|时间)\s*[:：]?/.test(title)) title = '';
    if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(title)) title = '';
    title = title
      .replace(/\s*结束时间\s*[:：]?.*$/g, '')
      .replace(/\s*时间\s*[:：]?.*$/g, '')
      .replace(/\s*\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:\s+\d{1,2}:\d{2})?(?:\s*[~～\-—]+\s*\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:\s+\d{1,2}:\d{2})?)?.*$/g, '')
      .replace(/\s*已交(?:付)?(?:\s*\d+(?:\.\d+)?\s*分)?/g, ' ')
      .replace(/\s*(已结束|已截止|未完成|部分完成|完成指标[:：]?.*$)/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!title || title.length < 2 || /^(结束时间|时间)$/.test(title)) {
      title = normalize(fullText)
        .replace(/\s*结束时间\s*[:：]?.*$/g, '')
        .replace(/\s*时间\s*[:：]?.*$/g, '')
        .replace(/\s*\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:\s+\d{1,2}:\d{2})?.*$/g, '')
        .replace(/\s*已交(?:付)?(?:\s*\d+(?:\.\d+)?\s*分)?|已结束|已截止|未完成|部分完成|完成指标[:：]?.*$/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }
    if (!title || /^(结束时间|时间)/.test(title) || /^\d{4}[-/.]/.test(title)) return '';
    return title.slice(0, 160);
  };
  /**
   * Real 2026 学在浙大 task page contract:
   *   /course/{id}/homework
   *   [ng-controller="HomeworkListController"]
   *   homework in homeworkList track by homework.id
   *
   * Rows without a rendered timestamp are still proof that the list loaded,
   * but they are not DDL candidates. This is common for already-ended work.
   */
  const extractTasksOnHomeworkPage = (course, allowEmpty = false) => {
    const controller = document.querySelector(
      '[ng-controller="HomeworkListController"]'
    );
    const rows = Array.from(document.querySelectorAll(TASK_ROW_SELECTOR));
    const loading = taskPageLoading(controller);
    const emptyNode = taskPageEmptyNode(controller);
    const controllerText = normalize(controller?.innerText || controller?.textContent);
    const shellReady = Boolean(
      controller &&
      (
        controller.querySelector('.homework-section') ||
        controller.querySelector('[ng-if*="homeworkList.length > 0"]') ||
        emptyNode ||
        /作业名称|作业形式/.test(controllerText)
      )
    );
    const stats = {
      controller: Boolean(controller),
      rowCount: rows.length,
      datedCount: 0,
      explicitEmpty: Boolean(emptyNode),
      loading,
      source: 'homeworkList'
    };
    if (!shellReady || loading) {
      return { ready: false, tasks: null, stats };
    }

    if (rows.length === 0) {
      if (!allowEmpty) return { ready: true, tasks: null, stats };
      return { ready: true, tasks: [], confirmedEmpty: true, stats };
    }

    const tasks = rows.flatMap((row) => {
      const taskText = normalize(row.innerText || row.textContent);
      const explicitTitle = normalize(
        row.querySelector(
          '[ng-bind="homework.title"], .shorten-title, .title, .activity-title'
        )?.textContent
      );
      const title = cleanTaskTitle(explicitTitle, taskText);
      if (!title) return [];
      // The web importer requires an exact deadline timestamp. Ended rows
      // commonly render only "已结束" and intentionally stay out of DDL data.
      if (!/\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\s+\d{1,2}:\d{2}/.test(taskText)) {
        return [];
      }
      stats.datedCount += 1;
      const activity = activityLink(row, course);
      return [{
        courseId: course.courseId,
        courseTitle: course.courseTitle,
        courseUrl: taskCourseUrl(course),
        ...activity,
        title,
        text: taskText.slice(0, 400)
      }];
    });
    return { ready: true, tasks, confirmedEmpty: false, stats };
  };

  const activityFromScoreRow = (row) => {
    try {
      const scope = window.angular?.element(row)?.scope?.();
      return scope?.activity || scope?.$parent?.activity || null;
    } catch (_) {
      return null;
    }
  };

  const collectScoreActivitiesFromScopes = () => {
    const state = {
      hasAngular: Boolean(window.angular?.element),
      scopeCount: 0,
      categoryCount: 0,
      activityCount: 0,
      homeworkCount: 0,
      activities: null
    };
    if (!window.angular?.element) return state;
    const elements = [
      document.querySelector('.score-page'),
      ...Array.from(document.querySelectorAll('.activity.row, [ng-repeat*="activity in category.activities"], [ng-controller], main, body'))
    ].filter(Boolean);
    const scopes = [];
    const seenScopes = new Set();
    const pushScope = (scope) => {
      let current = scope;
      let depth = 0;
      while (current && depth < 8) {
        if (!seenScopes.has(current)) {
          seenScopes.add(current);
          scopes.push(current);
        }
        current = current.$parent;
        depth += 1;
      }
    };
    for (const el of elements) {
      try { pushScope(window.angular.element(el).scope?.()); } catch (_) {}
      try { pushScope(window.angular.element(el).isolateScope?.()); } catch (_) {}
    }
    state.scopeCount = scopes.length;
    for (const scope of scopes) {
      const categories = scope?.activityCategories;
      if (!Array.isArray(categories)) continue;
      state.categoryCount = Math.max(state.categoryCount, categories.length);
      const activities = [];
      const seen = new Set();
      for (const category of categories) {
        for (const activity of Array.isArray(category?.activities) ? category.activities : []) {
          const key = String(activity?.id ?? activity?.activityId ?? activity?.activity_id ?? activity?.title ?? activities.length);
          if (seen.has(key)) continue;
          seen.add(key);
          activities.push(activity);
        }
      }
      if (activities.length > state.activityCount) {
        state.activities = activities;
        state.activityCount = activities.length;
        state.homeworkCount = activities.filter((activity) => String(activity?.type || '').toLowerCase() === 'homework').length;
      }
    }
    return state;
  };
  const gradeFromScoreActivity = (course, activity, rowText = '') => {
    if (String(activity?.type || '').toLowerCase() !== 'homework') return null;
    const title = normalize(activity?.title || rowText.split(' ')[0]);
    if (!title) return null;
    const status = String(activity?.student_status || activity?.status || '').toLowerCase();
    const rawScore = activity?.score;
    const score = rawScore === undefined || rawScore === null || rawScore === ''
      ? undefined
      : Number(String(rawScore).replace(/,/g, ''));
    let gradeStatus;
    if (status === 'scored' && Number.isFinite(score) && score >= 0) {
      gradeStatus = 'published';
    } else if (status === 'un_submitted' || /\u672a\u4ea4/.test(rowText)) {
      gradeStatus = 'missed';
    } else if (status === 'un_marked' || status === 'scored' || /\u672a\u516c\u5e03|\u672a\u6279\u6539/.test(rowText)) {
      gradeStatus = 'unpublished';
    } else if (/\u5df2\u7ed3\u675f|\u622a\u6b62/.test(rowText)) {
      gradeStatus = 'missed';
    } else {
      return null;
    }
    const activityId = activity?.id ?? activity?.activityId ?? activity?.activity_id;
    let activityUrl;
    try {
      if (activity?.url) activityUrl = new URL(activity.url, location.origin).href;
    } catch (_) {}
    return {
      courseId: course.courseId,
      courseTitle: course.courseTitle,
      courseUrl: gradeCourseUrl(course),
      ...(activityId != null ? { activityId: String(activityId) } : {}),
      ...(activityUrl ? { activityUrl } : {}),
      title,
      text: rowText.slice(0, 400),
      ...(gradeStatus === 'published' ? { score } : {}),
      gradeStatus
    };
  };

  /** Read the native /score page; an empty activity list is valid only after a bounded wait. */
  const extractGradesOnScorePage = (course, allowEmpty = false) => {
    const scoreShellReady = Boolean(
      document.querySelector('.score-page') ||
      document.querySelector('[ng-repeat*="category in"]') ||
      document.querySelector('[ng-repeat*="activity in category.activities"]') ||
      document.querySelector('.activity.row')
    );
    if (!scoreShellReady) return { ready: false, grades: null, stats: null };

    const scoreState = collectScoreActivitiesFromScopes();
    const rows = Array.from(document.querySelectorAll('.activity.row'))
      .filter((row) => (row.getAttribute('ng-repeat') || '').includes('activity in category.activities'));
    const found = [];
    const seen = new Set();
    const pushGrade = (grade) => {
      if (!grade) return;
      const key = `${grade.activityId || ''}|${grade.title}`;
      if (seen.has(key)) return;
      seen.add(key);
      found.push(grade);
    };

    if (Array.isArray(scoreState?.activities) && scoreState.activityCount > 0) {
      for (const activity of scoreState.activities) {
        pushGrade(gradeFromScoreActivity(course, activity));
      }
      return { ready: true, grades: found, stats: { ...scoreState, rowCount: rows.length, source: 'activityCategories' } };
    }

    if (rows.length > 0) {
      for (const row of rows) {
        const activity = activityFromScoreRow(row);
        const rowText = normalize(row.innerText || row.textContent);
        pushGrade(gradeFromScoreActivity(course, activity, rowText));
      }
      return { ready: true, grades: found, stats: { ...scoreState, rowCount: rows.length, source: 'rows' } };
    }

    if (allowEmpty) {
      return { ready: true, grades: [], stats: { ...scoreState, rowCount: rows.length, source: 'empty-after-wait' } };
    }
    return { ready: true, grades: null, stats: { ...scoreState, rowCount: rows.length, source: 'waiting' } };
  };
  /**
   * Only click in-course sub-nav (章节/作业), never sidebar "我的课程" etc.
   * Wrong clicks were kicking grades back to the course list.
   */
  const clickCourseTab = (label) => {
    // Restrict to top course header strip.
    const strip = document.querySelector(
      'nav, [class*="tab"], [class*="nav"], [role="tablist"]'
    ) || document.body;
    const candidates = Array.from(
      (strip === document.body
        ? document.querySelectorAll('a, button, li, span')
        : strip.querySelectorAll('a, button, li, span, [role="tab"]'))
    );
    const tab = candidates.find((el) => {
      const t = normalize(el.textContent);
      if (t !== label) return false;
      const r = el.getBoundingClientRect();
      // Course tabs sit in the upper content area, not the left sidebar.
      return r.width > 0 && r.height > 0 && r.width < 100 && r.left > 160 && r.top < 280;
    });
    if (!tab) return false;
    try { tab.click(); return true; } catch (_) { return false; }
  };

  const advanceTaskCourse = (results) => {
    const queue = readJson(TASK_QUEUE_KEY, []);
    const index = Number(sessionStorage.getItem(TASK_INDEX_KEY) || 0);
    const nextIndex = index + 1;
    if (nextIndex < queue.length) {
      const next = queue[nextIndex];
      progress(`任务：下一门课 (${nextIndex + 1}/${queue.length}) ${next.courseTitle || next.courseId}`);
      sessionStorage.setItem(TASK_INDEX_KEY, String(nextIndex));
      go(taskCourseUrl(next));
      return;
    }
    progress(`任务：全部课程扫完，回报 ${(results || []).length} 条原始记录`);
    finishTasks(results || readJson(TASK_RESULTS_KEY, []));
  };
  const advanceGradeCourse = (results) => {
    const queue = readJson(GRADE_QUEUE_KEY, []);
    const index = Number(sessionStorage.getItem(GRADE_INDEX_KEY) || 0);
    const nextIndex = index + 1;
    if (nextIndex < queue.length) {
      const next = queue[nextIndex];
      progress(`成绩：下一门课 (${nextIndex + 1}/${queue.length}) ${next.courseTitle || next.courseId}`);
      sessionStorage.setItem(GRADE_INDEX_KEY, String(nextIndex));
      go(gradeCourseUrl(next));
      return;
    }
    progress(`成绩：全部课程扫完，回报 ${(results || []).length} 条`);
    finishGrades(results || readJson(GRADE_RESULTS_KEY, []));
  };
  const commitGradeSnapshot = (course, grades) => {
    const results = readJson(GRADE_RESULTS_KEY, []);
    const keys = new Set(results.map((item) => `${item.courseId}|${item.title}`));
    let added = 0;
    for (const grade of grades || []) {
      const key = `${grade.courseId}|${grade.title}`;
      if (keys.has(key)) continue;
      keys.add(key);
      results.push(grade);
      added += 1;
    }
    sessionStorage.setItem(GRADE_RESULTS_KEY, JSON.stringify(results.slice(0, 300)));
    const pub = (grades || []).filter((g) => g.gradeStatus === 'published').length;
    const unp = (grades || []).filter((g) => g.gradeStatus === 'unpublished').length;
    const mis = (grades || []).filter((g) => g.gradeStatus === 'missed').length;
    progress(
      `ZJU grades: ${course.courseTitle || course.courseId} -> +${added} rows (this course ${(grades || []).length}: published ${pub}/unpublished ${unp}/missed ${mis}, total ${results.length})` +
      ((grades || []).length === 0 ? ' - no homework grades' : '')
    );
    advanceGradeCourse(results);
  };
  const scanGradeCourse = () => {
    const queue = readJson(GRADE_QUEUE_KEY, []);
    const index = Number(sessionStorage.getItem(GRADE_INDEX_KEY) || 0);
    const course = queue[index];
    if (!course) return finishGrades(readJson(GRADE_RESULTS_KEY, []));

    let attempts = 0;
    const inspect = () => {
      if (
        /learning-activity/.test(location.pathname + location.hash) ||
        !location.pathname.includes(`/course/${course.courseId}`) ||
        !isScoreRoute()
      ) {
        const bounceKey = 'fuckddl:zju:grades:bounce';
        const bounce = Number(sessionStorage.getItem(bounceKey) || '0') + 1;
        sessionStorage.setItem(bounceKey, String(bounce));
        if (bounce > 6) {
          progress(`成绩：课程页反复跳转，跳过 ${course.courseTitle || course.courseId}`);
          sessionStorage.removeItem(bounceKey);
          advanceGradeCourse(readJson(GRADE_RESULTS_KEY, []));
          return;
        }
        if (bounce === 1) {
          progress(`成绩：切换到 ${course.courseTitle || course.courseId} 成绩页`);
        }
        go(gradeCourseUrl(course));
        return;
      }
      sessionStorage.removeItem('fuckddl:zju:grades:bounce');

      const allowEmpty = attempts >= 18;
      const extracted = extractGradesOnScorePage(course, allowEmpty);
      const stats = extracted?.stats || {};
      const statLine = `scope${stats.scopeCount ?? 0}/cat${stats.categoryCount ?? 0}/act${stats.activityCount ?? 0}/hw${stats.homeworkCount ?? 0}/row${stats.rowCount ?? 0}/${stats.source || 'none'}`;
      if (!extracted || extracted.grades === null) {
        attempts += 1;
        if (attempts === 1) {
          progress(`成绩：打开 ${course.courseTitle || course.courseId} 成绩页，等待成绩结构…`);
        } else if (attempts % 5 === 0) {
          progress(`成绩：${course.courseTitle || course.courseId} 结构等待 ${attempts} · ${statLine}`);
        }
        if (attempts < 30) {
          setTimeout(inspect, 500);
          return;
        }
        progress(`成绩：${course.courseTitle || course.courseId} 成绩结构未就绪，跳过本课以保留旧数据 · ${statLine}`);
        advanceGradeCourse(readJson(GRADE_RESULTS_KEY, []));
        return;
      }
      progress(
        (extracted.grades || []).length === 0
          ? `成绩：${course.courseTitle || course.courseId} 未识别到 homework · ${statLine}`
          : `成绩：${course.courseTitle || course.courseId} 结构就绪 · ${statLine}`
      );
      commitGradeSnapshot(course, extracted.grades || []);
    };
    inspect();
  };

  const scanTaskCourse = () => {
    const queue = readJson(TASK_QUEUE_KEY, []);
    const index = Number(sessionStorage.getItem(TASK_INDEX_KEY) || 0);
    const course = queue[index];
    if (!course) return finishTasks(readJson(TASK_RESULTS_KEY, []));

    const recordTaskScan = (status) => {
      const stats = readJson(TASK_SCAN_STATS_KEY, { confirmed: 0, uncertain: 0 });
      stats[status] = Number(stats[status] || 0) + 1;
      sessionStorage.setItem(TASK_SCAN_STATS_KEY, JSON.stringify(stats));
    };
    let attempts = 0;
    const inspect = () => {
      if (
        /learning-activity/.test(location.pathname + location.hash) ||
        !location.pathname.includes(`/course/${course.courseId}`) ||
        !/\/homework(?:\/|$)/.test(location.pathname)
      ) {
        const bounceKey = 'fuckddl:zju:tasks:bounce';
        const bounce = Number(sessionStorage.getItem(bounceKey) || '0') + 1;
        sessionStorage.setItem(bounceKey, String(bounce));
        if (bounce > 6) {
          progress(`任务：课程页反复跳转，跳过 ${course.courseTitle || course.courseId}`);
          sessionStorage.removeItem(bounceKey);
          recordTaskScan('uncertain');
          advanceTaskCourse(readJson(TASK_RESULTS_KEY, []));
          return;
        }
        if (bounce === 1) {
          progress(`任务：页面离开课程，返回 ${course.courseTitle || course.courseId}`);
        }
        go(taskCourseUrl(course));
        return;
      }
      sessionStorage.removeItem('fuckddl:zju:tasks:bounce');

      const allowEmpty = attempts >= 18;
      const extracted = extractTasksOnHomeworkPage(course, allowEmpty);
      const stats = extracted?.stats || {};
      const statLine =
        `ctrl${stats.controller ? 1 : 0}/row${stats.rowCount ?? 0}` +
        `/ddl${stats.datedCount ?? 0}/empty${stats.explicitEmpty ? 1 : 0}` +
        `/loading${stats.loading ? 1 : 0}/${stats.source || 'none'}`;
      if (!extracted || extracted.tasks === null) {
        attempts += 1;
        if (attempts === 1) {
          progress(
            `任务：打开 ${course.courseTitle || course.courseId} 作业页，等待作业列表…`
          );
        } else if (attempts % 5 === 0) {
          progress(
            `任务：${course.courseTitle || course.courseId} 列表等待 ${attempts} · ${statLine}`
          );
        }
        if (attempts < 30) {
          setTimeout(inspect, 400);
        } else {
          recordTaskScan('uncertain');
          progress(
            `任务：${course.courseTitle || course.courseId} 作业列表未就绪，标记读取不确定 · ${statLine}`
          );
          advanceTaskCourse(readJson(TASK_RESULTS_KEY, []));
        }
        return;
      }

      recordTaskScan('confirmed');
      const tasks = extracted.tasks || [];
      const results = readJson(TASK_RESULTS_KEY, []);
      const keys = new Set(results.map((item) => `${item.courseId}|${item.title}|${item.text}`));
      let added = 0;
      for (const task of tasks) {
        const key = `${task.courseId}|${task.title}|${task.text}`;
        if (keys.has(key)) continue;
        keys.add(key);
        results.push(task);
        added += 1;
      }
      sessionStorage.setItem(TASK_RESULTS_KEY, JSON.stringify(results.slice(0, 200)));
      if (extracted.confirmedEmpty) {
        progress(
          `任务：${course.courseTitle || course.courseId} 已确认作业列表为空 · ${statLine}`
        );
      } else {
        progress(
          `任务：${course.courseTitle || course.courseId} 列表${stats.rowCount ?? 0}条` +
          ` / DDL候选${tasks.length}条 → +${added}（累计${results.length}） · ${statLine}`
        );
      }
      advanceTaskCourse(results);
    };
    inspect();
  };
  const ensureTaskQueueFromSeed = () => {
    if (sessionStorage.getItem(TASK_QUEUE_KEY)) return true;
    const seed = readJson(COURSE_SEED_KEY, []);
    if (seed.length === 0) return false;
    startTaskQueue(seed.map((course) => ({ ...course, courseUrl: taskCourseUrl(course) })));
    return true;
  };
  const ensureGradeQueueFromSeed = () => {
    if (sessionStorage.getItem(GRADE_QUEUE_KEY)) return true;
    const seed = readJson(COURSE_SEED_KEY, []);
    if (seed.length === 0) return false;
    startGradeQueue(seed.map((course) => ({ ...course, courseUrl: gradeCourseUrl(course) })));
    return true;
  };
  afterDomReady(() => {
    if (location.pathname === '/user/courses' || location.pathname === '/user/index') {
      const modeParam = new URLSearchParams(location.search).get('fuckddl-sync');
      if (modeParam === 'grades' || modeParam === 'tasks' || modeParam === 'courses') {
        sessionStorage.setItem(MODE_KEY, modeParam);
      } else if (!sessionStorage.getItem(MODE_KEY)) {
        sessionStorage.setItem(MODE_KEY, 'tasks');
      }
      scanCourses();
      return;
    }
    if (!/^\/course\/\d+/.test(location.pathname)) return;

    const mode = readMode();
    if (mode === 'grades') {
      if (!ensureGradeQueueFromSeed()) return;
      const queue = readJson(GRADE_QUEUE_KEY, []);
      const index = Number(sessionStorage.getItem(GRADE_INDEX_KEY) || 0);
      const course = queue[index];
      if (!course) return finishGrades(readJson(GRADE_RESULTS_KEY, []));
      if (/learning-activity/.test(location.pathname + location.hash) || !isScoreRoute()) {
        go(gradeCourseUrl(course));
        return;
      }
      scanGradeCourse();
      return;
    }

    sessionStorage.setItem(MODE_KEY, 'tasks');
    if (!ensureTaskQueueFromSeed()) return;
    const queue = readJson(TASK_QUEUE_KEY, []);
    const index = Number(sessionStorage.getItem(TASK_INDEX_KEY) || 0);
    const course = queue[index];
    if (!course) return finishTasks(readJson(TASK_RESULTS_KEY, []));
    if (/learning-activity/.test(location.pathname + location.hash) || !/\/homework(?:\/|$)/.test(location.pathname)) {
      go(taskCourseUrl(course));
      return;
    }
    scanTaskCourse();
  });})();
"#;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ZjuGradeStatus {
    Published,
    Unpublished,
    Missed,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ZjuActivity {
    course_id: String,
    course_title: String,
    course_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    activity_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    activity_url: Option<String>,
    title: String,
    text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    score: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    max_score: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    grade_status: Option<ZjuGradeStatus>,
}

fn allowed_navigation(url: &Url) -> bool {
    if url.scheme() == "fuckddl-sync" {
        return false;
    }
    if url.scheme() == "about" {
        return url.as_str() == "about:blank";
    }
    if url.scheme() != "https" {
        return false;
    }
    matches!(
        url.host_str(),
        Some("courses.zju.edu.cn")
            | Some("identity.zju.edu.cn")
            | Some("zjuam.zju.edu.cn")
            | Some("login.microsoftonline.com")
    )
}

fn is_login_page(url: &Url) -> bool {
    matches!(
        url.host_str(),
        Some("identity.zju.edu.cn") | Some("zjuam.zju.edu.cn")
    )
}

fn is_bridge_signal(url: &Url, host: &str) -> bool {
    url.scheme() == "fuckddl-sync" && url.host_str() == Some(host)
}

fn is_valid_course_url(value: &str, course_id: &str) -> bool {
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    let path = url.path().trim_end_matches('/');
    let prefix = format!("/course/{course_id}");
    url.scheme() == "https"
        && url.host_str() == Some("courses.zju.edu.cn")
        && (path == prefix || path.starts_with(&format!("{prefix}/")))
}

fn has_valid_grade(record: &ZjuActivity) -> bool {
    let valid_number = |value: f64| value.is_finite() && (0.0..=1_000_000.0).contains(&value);
    if record.score.is_some_and(|score| !valid_number(score))
        || record
            .max_score
            .is_some_and(|max_score| !valid_number(max_score) || max_score == 0.0)
    {
        return false;
    }
    match record.grade_status {
        // Published must carry a finite score (0 is allowed only as a real 0分).
        Some(ZjuGradeStatus::Published) => record.score.is_some(),
        // Unpublished / missed must not invent a score.
        Some(ZjuGradeStatus::Unpublished | ZjuGradeStatus::Missed) => record.score.is_none(),
        None => record.score.is_none() && record.max_score.is_none(),
    }
}

/// Drop only the bad rows — never reject the whole grade payload (was wiping 17 good rows).
fn sanitize_report_records(records: Vec<ZjuActivity>) -> Option<Vec<ZjuActivity>> {
    if records.len() > 200 {
        return None;
    }
    let mut cleaned = Vec::with_capacity(records.len());
    for mut record in records {
        if record.course_id.is_empty()
            || !record
                .course_id
                .chars()
                .all(|character| character.is_ascii_digit())
            || record.course_title.is_empty()
            || record.course_title.len() > 512
            || record.title.is_empty()
            || record.title.len() > 1_024
            || record.text.len() > 8_192
            || !is_valid_course_url(&record.course_url, &record.course_id)
        {
            continue;
        }
        // Normalize inconsistent grade pairs instead of dropping the batch.
        match record.grade_status {
            Some(ZjuGradeStatus::Published) if record.score.is_none() => {
                // List "已交" without a number is unpublished, not a blank published.
                record.grade_status = Some(ZjuGradeStatus::Unpublished);
            }
            Some(ZjuGradeStatus::Unpublished | ZjuGradeStatus::Missed)
                if record.score.is_some() =>
            {
                // Do not invent 0分 on unpublished/missed rows — drop the score.
                record.score = None;
                record.max_score = None;
            }
            _ => {}
        }
        if record.activity_id.is_some() != record.activity_url.is_some() {
            record.activity_id = None;
            record.activity_url = None;
        }
        if record.activity_id.as_ref().is_some_and(|activity_id| {
            activity_id.is_empty()
                || activity_id.len() > 64
                || !activity_id
                    .chars()
                    .all(|character| character.is_ascii_digit())
        }) {
            record.activity_id = None;
            record.activity_url = None;
        }
        if record.activity_url.as_ref().is_some_and(|activity_url| {
            !is_valid_course_url(activity_url, &record.course_id)
                || !activity_url.contains("/learning-activity/")
        }) {
            record.activity_id = None;
            record.activity_url = None;
        }
        if !has_valid_grade(&record) {
            continue;
        }
        cleaned.push(record);
    }
    // Empty is a valid "no grades found" snapshot.
    Some(cleaned)
}

fn decode_progress_message(url: &Url) -> Option<String> {
    if !is_bridge_signal(url, "zju-progress") {
        return None;
    }
    let payload = url
        .query_pairs()
        .find_map(|(key, value)| (key == "payload").then(|| value.into_owned()))?;
    if payload.len() > 8 * 1024 {
        return None;
    }
    #[derive(Deserialize)]
    struct ProgressPayload {
        message: String,
    }
    let parsed: ProgressPayload = serde_json::from_str(&payload).ok()?;
    let message = parsed.message.trim().to_string();
    if message.is_empty() || message.len() > 240 {
        return None;
    }
    Some(message)
}

fn decode_course_catalog(url: &Url) -> Option<Vec<ZjuCourseSelection>> {
    if !is_bridge_signal(url, "zju-courses") {
        return None;
    }
    let payload = url
        .query_pairs()
        .find_map(|(key, value)| (key == "payload").then(|| value.into_owned()))?;
    if payload.len() > MAX_PAYLOAD_BYTES {
        return None;
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct RawCatalogItem {
        course_id: String,
        #[serde(default)]
        course_title: Option<String>,
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        course_url: Option<String>,
        #[serde(default)]
        semester: Option<String>,
        #[serde(default)]
        text: Option<String>,
    }
    let records: Vec<RawCatalogItem> = serde_json::from_str(&payload).ok()?;
    if records.len() > 200 {
        return None;
    }
    let mut courses = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for record in records {
        if !seen.insert(record.course_id.clone()) {
            continue;
        }
        let title = record.course_title.or(record.title).unwrap_or_default();
        let semester = record
            .semester
            .or(record.text)
            .filter(|value| !value.is_empty() && value != "catalog");
        if let Some(course) = sanitized_course_selection(&ZjuCourseSelection {
            course_id: record.course_id,
            course_title: title,
            course_url: record.course_url,
            semester,
        }) {
            courses.push(course);
        }
    }
    Some(courses)
}

fn decode_report(url: &Url) -> Option<Vec<ZjuActivity>> {
    if !is_bridge_signal(url, "zju") {
        return None;
    }
    let payload = url
        .query_pairs()
        .find_map(|(key, value)| (key == "payload").then(|| value.into_owned()))?;
    if payload.len() > MAX_PAYLOAD_BYTES {
        return None;
    }
    let records: Vec<ZjuActivity> = serde_json::from_str(&payload).ok()?;
    sanitize_report_records(records)
}

fn create_window(
    app: &AppHandle,
    initial_url: &str,
    visible: bool,
    bootstrap_script: Option<&str>,
) -> Result<(), String> {
    let app_for_navigation = app.clone();
    let app_for_page_load = app.clone();
    let url = initial_url
        .parse()
        .map_err(|_| "zju-url-invalid".to_string())?;
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "zju-main-window-missing".to_string())?;
    let mut builder = WebviewWindowBuilder::new(app, ZJU_WINDOW_LABEL, WebviewUrl::External(url))
        .title("Fuck DDL · 学在浙大")
        .inner_size(1180.0, 800.0)
        .center()
        .visible(visible)
        .focused(visible);
    if let Some(script) = bootstrap_script {
        // Run before EXTRACT_SCRIPT so queue/mode exist when the page boots.
        builder = builder.initialization_script(script);
    }
    let builder = builder
        .initialization_script(EXTRACT_SCRIPT)
        .on_page_load(move |_window, payload| {
            if matches!(payload.event(), PageLoadEvent::Started) && is_login_page(payload.url()) {
                let _ = app_for_page_load.emit_to("main", "fuck-ddl:zju-login-required", ());
            }
        })
        .on_navigation(move |url| {
            if let Some(message) = decode_progress_message(url) {
                // Keep the catalog window open; only forward debug lines.
                let _ = app_for_navigation.emit_to("main", "fuck-ddl:zju-progress", message);
                return false;
            }
            if let Some(records) = decode_report(url) {
                let _ = app_for_navigation.emit_to("main", "fuck-ddl:zju-sync", records);
                if let Some(window) = app_for_navigation.get_webview_window(ZJU_WINDOW_LABEL) {
                    let _ = window.hide();
                }
                return false;
            }
            if let Some(courses) = decode_course_catalog(url) {
                let _ = app_for_navigation.emit_to("main", "fuck-ddl:zju-courses", courses);
                if let Some(window) = app_for_navigation.get_webview_window(ZJU_WINDOW_LABEL) {
                    let _ = window.hide();
                }
                return false;
            }
            if is_bridge_signal(url, "zju-extract-failed") {
                let _ = app_for_navigation.emit_to("main", "fuck-ddl:zju-extract-failed", ());
                if let Some(window) = app_for_navigation.get_webview_window(ZJU_WINDOW_LABEL) {
                    let _ = window.hide();
                }
                return false;
            }
            allowed_navigation(url)
        });
    builder
        .parent(&main)
        .map_err(|error| format!("zju-window-parent-failed:{error}"))?
        .build()
        .map_err(|error| format!("zju-window-create-failed:{error}"))?;
    Ok(())
}

#[tauri::command]
pub async fn open_zju_login(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(ZJU_WINDOW_LABEL) {
        window
            .show()
            .and_then(|_| window.set_focus())
            .map_err(|error| format!("zju-window-show-failed:{error}"))?;
        return Ok(());
    }
    create_window(&app, ZJU_HOME_URL, true, None)
}

/// `force_reset=true` for eval-before-navigate (wipe prior crawl).
/// `force_reset=false` for window initialization_script (idempotent; init re-runs each page).
fn seed_script(
    mode: &str,
    courses: &[ZjuCourseSelection],
    force_reset: bool,
) -> Result<String, String> {
    // Also wipe grade-scroll keys so a prior grades crawl cannot poison task mode.
    let clear = "['fuckddl:zju:tasks:queue','fuckddl:zju:tasks:results','fuckddl:zju:tasks:index','fuckddl:zju:tasks:activity-queue','fuckddl:zju:tasks:activity-index','fuckddl:zju:tasks:scan-stats','fuckddl:zju:tasks:catalog-accum','fuckddl:zju:tasks:catalog-page','fuckddl:zju:tasks:catalog-wait','fuckddl:zju:tasks:catalog-fp','fuckddl:zju:grades:queue','fuckddl:zju:grades:results','fuckddl:zju:grades:index',\
        'fuckddl:zju:queue','fuckddl:zju:results','fuckddl:zju:index',\
        'fuckddl:zju:activity-queue','fuckddl:zju:activity-index',\
        'fuckddl:zju:course-seed','fuckddl:zju:courses-accum','fuckddl:zju:courses-page',\
        'fuckddl:zju:courses-wait','fuckddl:zju:courses-phase','fuckddl:zju:courses-fp',\
        'fuckddl:zju:courses-method','fuckddl:zju:courses-size']\
        .forEach((k) => sessionStorage.removeItem(k));\
        try { Object.keys(sessionStorage).forEach((k) => {\
          if (k.indexOf('fuckddl:zju:grades:') === 0 || k.indexOf('fuckddl:zju:grade-') === 0) sessionStorage.removeItem(k);\
        }); } catch (_) {}";
    if mode == "grades" {
        let queue = courses
            .iter()
            .filter_map(|course| {
                let course = sanitized_course_selection(course)?;
                Some(serde_json::json!({
                    "courseId": course.course_id,
                    "courseTitle": course.course_title,
                    "courseUrl": grade_course_url(&course.course_id),
                }))
            })
            .collect::<Vec<_>>();
        let payload = serde_json::to_string(&queue)
            .map_err(|error| format!("zju-seed-json-failed:{error}"))?;
        // JSON is embedded as a JS string literal via serde_json::to_string of the string.
        let literal = serde_json::to_string(&payload)
            .map_err(|error| format!("zju-seed-literal-failed:{error}"))?;
        if force_reset {
            return Ok(format!(
                "try {{ {clear} \
                 sessionStorage.setItem('fuckddl:zju:mode', 'grades'); \
                 sessionStorage.setItem('fuckddl:zju:course-seed', {literal}); \
                 sessionStorage.setItem('fuckddl:zju:grades:queue', {literal}); \
                 sessionStorage.setItem('fuckddl:zju:grades:results', '[]'); \
                 sessionStorage.setItem('fuckddl:zju:grades:index', '0'); \
                 }} catch (_) {{}}"
            ));
        }
        return Ok(format!(
            "try {{ \
             if (!sessionStorage.getItem('fuckddl:zju:grades:queue')) {{ \
               sessionStorage.setItem('fuckddl:zju:mode', 'grades'); \
               sessionStorage.setItem('fuckddl:zju:course-seed', {literal}); \
               sessionStorage.setItem('fuckddl:zju:grades:queue', {literal}); \
               sessionStorage.setItem('fuckddl:zju:grades:results', '[]'); \
               sessionStorage.setItem('fuckddl:zju:grades:index', '0'); \
             }} \
             }} catch (_) {{}}"
        ));
    }
    if force_reset {
        return Ok(format!(
            "try {{ {clear} sessionStorage.setItem('fuckddl:zju:mode', '{mode}'); }} catch (_) {{}}"
        ));
    }
    Ok(format!(
        "try {{ \
         if (!sessionStorage.getItem('fuckddl:zju:mode')) {{ \
           sessionStorage.setItem('fuckddl:zju:mode', '{mode}'); \
         }} \
         }} catch (_) {{}}"
    ))
}

#[tauri::command]
pub async fn sync_zju(app: AppHandle, options: Option<ZjuSyncOptions>) -> Result<(), String> {
    let options = options.unwrap_or_default();
    let mode = zju_sync_mode(options.mode.as_deref());
    let courses = options
        .courses
        .unwrap_or_default()
        .into_iter()
        .filter_map(|course| sanitized_course_selection(&course))
        .collect::<Vec<_>>();

    if mode == "grades" && courses.is_empty() {
        // Never crawl every course for grades — empty selection is a no-op.
        let _ = app.emit_to("main", "fuck-ddl:zju-sync", Vec::<ZjuActivity>::new());
        return Ok(());
    }

    let sync_url = zju_sync_url(Some(&ZjuSyncOptions {
        mode: Some(mode.to_string()),
        courses: Some(courses.clone()),
    }))?;
    let eval_seed = seed_script(mode, &courses, true)?;
    let init_seed = seed_script(mode, &courses, false)?;

    // Show the window for catalog + grades so hangs are visible and diagnosable.
    let show_window = mode == "courses" || mode == "grades";

    if let Some(window) = app.get_webview_window(ZJU_WINDOW_LABEL) {
        let _ = window.eval(&eval_seed);
        if show_window {
            window
                .show()
                .and_then(|_| window.set_focus())
                .map_err(|error| format!("zju-window-show-failed:{error}"))?;
        } else {
            window
                .hide()
                .map_err(|error| format!("zju-window-hide-failed:{error}"))?;
        }
        window
            .navigate(
                sync_url
                    .parse()
                    .map_err(|_| "zju-url-invalid".to_string())?,
            )
            .map_err(|error| format!("zju-navigation-failed:{error}"))?;
        return Ok(());
    }
    create_window(&app, &sync_url, show_window, Some(&init_seed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigation_is_limited_to_zju_login_dependencies() {
        assert!(allowed_navigation(&ZJU_HOME_URL.parse().unwrap()));
        assert!(allowed_navigation(
            &"https://zjuam.zju.edu.cn/cas/login".parse().unwrap()
        ));
        assert!(allowed_navigation(
            &"https://identity.zju.edu.cn/auth/realms/zju"
                .parse()
                .unwrap()
        ));
        assert!(!allowed_navigation(&"https://example.com".parse().unwrap()));
        assert!(!allowed_navigation(
            &"file:///C:/secret.txt".parse().unwrap()
        ));
    }

    #[test]
    fn login_pages_are_reported_without_blocking_navigation() {
        let login = "https://zjuam.zju.edu.cn/cas/login".parse().unwrap();
        assert!(is_login_page(&login));
        assert!(allowed_navigation(&login));
        assert!(!is_login_page(&ZJU_HOME_URL.parse().unwrap()));
    }

    #[test]
    fn extract_script_keeps_task_and_grade_pipelines_separate() {
        assert!(EXTRACT_SCRIPT.contains("const taskCourseUrl"));
        assert!(EXTRACT_SCRIPT.contains("/homework`"));
        assert!(EXTRACT_SCRIPT.contains("const gradeCourseUrl"));
        assert!(EXTRACT_SCRIPT.contains("/score#/`"));
        assert!(EXTRACT_SCRIPT.contains("TASK_QUEUE_KEY"));
        assert!(EXTRACT_SCRIPT.contains("GRADE_QUEUE_KEY"));
        assert!(EXTRACT_SCRIPT.contains("advanceTaskCourse"));
        assert!(EXTRACT_SCRIPT.contains("advanceGradeCourse"));
        assert!(!EXTRACT_SCRIPT.contains("courseUrlForMode"));
        assert!(!EXTRACT_SCRIPT.contains("scanCoursePipeline"));
        assert!(!EXTRACT_SCRIPT.contains("extractGradesOnContentPage"));

        let grade_start = EXTRACT_SCRIPT.find("const scanGradeCourse").unwrap();
        let task_start = EXTRACT_SCRIPT.find("const scanTaskCourse").unwrap();
        let ensure_start = EXTRACT_SCRIPT
            .find("const ensureTaskQueueFromSeed")
            .unwrap();
        let grade_pipeline = &EXTRACT_SCRIPT[grade_start..task_start];
        let task_pipeline = &EXTRACT_SCRIPT[task_start..ensure_start];
        assert!(grade_pipeline.contains("GRADE_QUEUE_KEY"));
        assert!(grade_pipeline.contains("extractGradesOnScorePage"));
        assert!(!grade_pipeline.contains("TASK_QUEUE_KEY"));
        assert!(!grade_pipeline.contains("extractTasksOnHomeworkPage"));
        assert!(task_pipeline.contains("TASK_QUEUE_KEY"));
        assert!(task_pipeline.contains("extractTasksOnHomeworkPage"));
        assert!(!task_pipeline.contains("GRADE_QUEUE_KEY"));
        assert!(!task_pipeline.contains("extractGradesOnScorePage"));

        assert!(EXTRACT_SCRIPT.contains("TASK_SCAN_STATS_KEY"));
        assert!(EXTRACT_SCRIPT.contains("TASK_CATALOG_ACCUM_KEY"));
        assert!(EXTRACT_SCRIPT.contains("TASK_CATALOG_PAGE_KEY"));
        assert!(EXTRACT_SCRIPT.contains("MAX_TASK_COURSES"));
        assert!(EXTRACT_SCRIPT.contains("任务：读取课程第${page}页"));
        assert!(EXTRACT_SCRIPT.contains("go(catalogPageUrl(page + 1, 'tasks'))"));
        assert!(EXTRACT_SCRIPT
            .contains("Do not start the homework queue until every catalog page has been read."));
        assert!(EXTRACT_SCRIPT.contains("作业列表未就绪，标记读取不确定"));
        assert!(EXTRACT_SCRIPT.contains("保留已有任务并报告读取失败"));
        assert!(EXTRACT_SCRIPT.contains("signal('zju-extract-failed')"));
        assert!(EXTRACT_SCRIPT.contains("enqueueHref"));
        assert!(EXTRACT_SCRIPT.contains("zju-courses"));
        assert!(EXTRACT_SCRIPT.contains("scrollCatalogToPager"));
        assert!(EXTRACT_SCRIPT.contains("collectScoreActivitiesFromScopes"));
        assert!(EXTRACT_SCRIPT.contains("activity in category.activities"));
        assert!(EXTRACT_SCRIPT.contains("HomeworkListController"));
        assert!(EXTRACT_SCRIPT.contains("homework in homeworkList track by homework.id"));
        assert!(EXTRACT_SCRIPT.contains("[ng-bind=\"homework.title\"]"));
        assert!(EXTRACT_SCRIPT.contains("taskPageLoading"));
        assert!(EXTRACT_SCRIPT.contains("confirmedEmpty"));
    }
    #[test]
    fn task_and_grade_seed_state_are_isolated() {
        let task_seed = seed_script("tasks", &[], true).unwrap();
        assert!(task_seed.contains("setItem('fuckddl:zju:mode', 'tasks')"));
        assert!(!task_seed.contains("setItem('fuckddl:zju:grades:queue'"));

        let courses = vec![ZjuCourseSelection {
            course_id: "99089".into(),
            course_title: "信息安全课程综合实践".into(),
            course_url: None,
            semester: Some("2025-2026春夏".into()),
        }];
        let grade_seed = seed_script("grades", &courses, true).unwrap();
        assert!(grade_seed.contains("setItem('fuckddl:zju:grades:queue'"));
        assert!(grade_seed.contains("setItem('fuckddl:zju:grades:results', '[]')"));
        assert!(!grade_seed.contains("setItem('fuckddl:zju:tasks:queue'"));
    }
    #[test]
    fn zju_task_and_grade_urls_carry_mode() {
        let tasks = Url::parse(
            &zju_sync_url(Some(&ZjuSyncOptions {
                mode: Some("tasks".to_string()),
                courses: None,
            }))
            .unwrap(),
        )
        .unwrap();
        let grades = Url::parse(
            &zju_sync_url(Some(&ZjuSyncOptions {
                mode: Some("grades".to_string()),
                courses: Some(vec![ZjuCourseSelection {
                    course_id: "99089".into(),
                    course_title: "信息安全课程综合实践".into(),
                    course_url: Some("https://courses.zju.edu.cn/course/99089/content".into()),
                    semester: Some("2025-2026春夏".into()),
                }]),
            }))
            .unwrap(),
        )
        .unwrap();
        let courses = Url::parse(
            &zju_sync_url(Some(&ZjuSyncOptions {
                mode: Some("courses".to_string()),
                courses: None,
            }))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            tasks
                .query_pairs()
                .find(|(k, _)| k == "fuckddl-sync")
                .map(|(_, v)| v.into_owned())
                .as_deref(),
            Some("tasks")
        );
        assert!(grades.as_str().contains("/course/99089/score#/"));
        assert_eq!(
            courses
                .query_pairs()
                .find(|(k, _)| k == "fuckddl-sync")
                .map(|(_, v)| v.into_owned())
                .as_deref(),
            Some("courses")
        );
    }

    #[test]
    fn report_accepts_only_bounded_course_records() {
        let payload = serde_json::json!([{
            "courseId": "99089",
            "courseTitle": "信息安全课程综合实践",
            "courseUrl": "https://courses.zju.edu.cn/course/99089/content",
            "title": "Lab0",
            "text": "结束时间: 2026-07-21 23:59 部分完成"
        }]);
        let url = Url::parse_with_params("fuckddl-sync://zju", &[("payload", payload.to_string())])
            .unwrap();
        assert_eq!(decode_report(&url).unwrap().len(), 1);

        let foreign = serde_json::json!([{
            "courseId": "99089",
            "courseTitle": "伪造课程",
            "courseUrl": "https://example.com/course/99089/content",
            "title": "伪造任务",
            "text": "结束时间: 2026-07-21 23:59"
        }]);
        let url = Url::parse_with_params("fuckddl-sync://zju", &[("payload", foreign.to_string())])
            .unwrap();
        // Invalid rows are dropped; empty report is still a valid decode.
        assert_eq!(decode_report(&url).unwrap().len(), 0);
    }

    fn report_url(payload: serde_json::Value) -> Url {
        Url::parse_with_params("fuckddl-sync://zju", &[("payload", payload.to_string())]).unwrap()
    }

    #[test]
    fn report_preserves_a_published_zju_grade() {
        let payload = serde_json::json!([{
            "courseId": "95870",
            "courseTitle": "大学物理（乙）I",
            "courseUrl": "https://courses.zju.edu.cn/course/95870/content",
            "activityId": "1100067",
            "activityUrl": "https://courses.zju.edu.cn/course/95870/learning-activity/full-screen#/1100067",
            "title": "第10章作业",
            "text": "已交 已结束",
            "score": 5.0,
            "maxScore": 5.0,
            "gradeStatus": "published"
        }]);
        let records = decode_report(&report_url(payload)).unwrap();
        assert_eq!(records[0].score, Some(5.0));
        assert_eq!(records[0].max_score, Some(5.0));
        assert_eq!(records[0].grade_status, Some(ZjuGradeStatus::Published));
    }

    #[test]
    fn report_keeps_valid_rows_when_one_grade_is_inconsistent() {
        // Previously any() invalid grade dropped the whole payload → UI empty ledger.
        let payload = serde_json::json!([
            {
                "courseId": "95870",
                "courseTitle": "大学物理（乙）I",
                "courseUrl": "https://courses.zju.edu.cn/course/95870/content",
                "title": "第10章作业",
                "text": "已交 5分 已结束",
                "score": 5.0,
                "gradeStatus": "published"
            },
            {
                "courseId": "95870",
                "courseTitle": "大学物理（乙）I",
                "courseUrl": "https://courses.zju.edu.cn/course/95870/content",
                "title": "坏行",
                "text": "已交",
                "score": 0.0,
                "gradeStatus": "unpublished"
            },
            {
                "courseId": "95870",
                "courseTitle": "大学物理（乙）I",
                "courseUrl": "https://courses.zju.edu.cn/course/95870/content",
                "title": "第12章作业",
                "text": "已交 5分 已结束",
                "score": 5.0,
                "gradeStatus": "published"
            }
        ]);
        let records = decode_report(&report_url(payload)).unwrap();
        assert!(records.len() >= 2);
        assert!(records.iter().any(|r| r.title == "第10章作业"));
        assert!(records.iter().any(|r| r.title == "第12章作业"));
    }

    #[test]
    fn report_keeps_an_unpublished_grade_unknown_instead_of_zero() {
        let payload = serde_json::json!([{
            "courseId": "95870",
            "courseTitle": "大学物理（乙）I",
            "courseUrl": "https://courses.zju.edu.cn/course/95870/content",
            "activityId": "1100053",
            "activityUrl": "https://courses.zju.edu.cn/course/95870/learning-activity/full-screen#/1100053",
            "title": "第3章作业",
            "text": "已交 已结束",
            "gradeStatus": "unpublished"
        }]);
        let records = decode_report(&report_url(payload)).unwrap();
        assert_eq!(records[0].score, None);
        assert_eq!(records[0].max_score, None);
        assert_eq!(records[0].grade_status, Some(ZjuGradeStatus::Unpublished));

        let false_zero = serde_json::json!([{
            "courseId": "95870",
            "courseTitle": "大学物理（乙）I",
            "courseUrl": "https://courses.zju.edu.cn/course/95870/content",
            "activityId": "1100053",
            "activityUrl": "https://courses.zju.edu.cn/course/95870/learning-activity/full-screen#/1100053",
            "title": "第3章作业",
            "text": "不公布",
            "score": 0,
            "gradeStatus": "unpublished"
        }]);
        // Invented 0 is stripped; row kept as unpublished with no score.
        let fixed = decode_report(&report_url(false_zero)).unwrap();
        assert_eq!(fixed.len(), 1);
        assert_eq!(fixed[0].score, None);
        assert_eq!(fixed[0].grade_status, Some(ZjuGradeStatus::Unpublished));
    }

    #[test]
    fn report_marks_a_closed_unsubmitted_homework_as_missed() {
        let payload = serde_json::json!([{
            "courseId": "95623",
            "courseTitle": "计算机系统 I",
            "courseUrl": "https://courses.zju.edu.cn/course/95623/content",
            "activityId": "1127860",
            "activityUrl": "https://courses.zju.edu.cn/course/95623/learning-activity/full-screen#/1127860",
            "title": "补交通道",
            "text": "作业已经截止交付 未提交",
            "gradeStatus": "missed"
        }]);
        let records = decode_report(&report_url(payload)).unwrap();
        assert_eq!(records[0].score, None);
        assert_eq!(records[0].grade_status, Some(ZjuGradeStatus::Missed));
    }
}
