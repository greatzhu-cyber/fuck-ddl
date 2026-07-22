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
            let url = first.course_url.clone().unwrap_or_else(|| {
                format!(
                    "https://courses.zju.edu.cn/course/{}/content",
                    first.course_id
                )
            });
            return Ok(url);
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

  const QUEUE_KEY = 'fuckddl:zju:queue';
  const RESULTS_KEY = 'fuckddl:zju:results';
  const INDEX_KEY = 'fuckddl:zju:index';
  const ACTIVITY_QUEUE_KEY = 'fuckddl:zju:activity-queue';
  const ACTIVITY_INDEX_KEY = 'fuckddl:zju:activity-index';
  const MODE_KEY = 'fuckddl:zju:mode';
  const COURSE_SEED_KEY = 'fuckddl:zju:course-seed';
  const COURSES_ACCUM_KEY = 'fuckddl:zju:courses-accum';
  const COURSES_PAGE_KEY = 'fuckddl:zju:courses-page';
  // Keep crawls bounded to avoid WebView2 OOM / long hangs.
  const MAX_COURSES = 20;
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
  const clearScan = () => {
    sessionStorage.removeItem(QUEUE_KEY);
    sessionStorage.removeItem(RESULTS_KEY);
    sessionStorage.removeItem(INDEX_KEY);
    sessionStorage.removeItem(ACTIVITY_QUEUE_KEY);
    sessionStorage.removeItem(ACTIVITY_INDEX_KEY);
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
  const fail = () => {
    clearScan();
    signal('zju-extract-failed');
  };
  const finish = (results) => {
    const mode = readMode();
    clearScan();
    if (mode === 'tasks') {
      // Drop grade fields so task sync never writes the grade ledger.
      signal('zju', (results || []).map((item) => {
        const { gradeStatus, score, maxScore, ...taskFields } = item || {};
        return taskFields;
      }));
      return;
    }
    if (mode === 'courses') {
      signal('zju-courses', results || []);
      return;
    }
    // Grades: strip activity detail links. Invalid activityUrl used to make the
    // whole payload fail bridge validation → frontend hung with no event.
    signal('zju', (results || []).map((item) => {
      const {
        activityId,
        activityUrl,
        ...rest
      } = item || {};
      return rest;
    }));
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

  const catalogPageUrl = (pageNum) => {
    const base = `${location.origin}/user/courses`;
    // Try both query + hash pageIndex (学在浙大 SPA is inconsistent across versions).
    return `${base}?fuckddl-sync=courses&pageIndex=${pageNum}&page=${pageNum}&_t=${Date.now()}#/?pageIndex=${pageNum}`;
  };
  const startCourseQueue = (courses) => {
    sessionStorage.setItem(QUEUE_KEY, JSON.stringify(courses));
    sessionStorage.setItem(RESULTS_KEY, '[]');
    sessionStorage.setItem(INDEX_KEY, '0');
    sessionStorage.setItem(ACTIVITY_QUEUE_KEY, '[]');
    sessionStorage.setItem(ACTIVITY_INDEX_KEY, '0');
    // Clear grade scroll state so modes never leak into each other.
    try {
      Object.keys(sessionStorage).forEach((k) => {
        if (k.startsWith('fuckddl:zju:grade-')) sessionStorage.removeItem(k);
      });
    } catch (_) {}
    if (courses.length === 0) {
      finish([]);
      return;
    }
    const first = courses[0];
    const url = first.courseUrl || `${location.origin}/course/${first.courseId}/content`;
    go(url);
  };
  const scanCourses = () => {
    const mode = readMode();
    // Grades: only crawl user-selected courses seeded by the desktop bridge.
    if (mode === 'grades') {
      const existing = readJson(QUEUE_KEY, []);
      const idx = sessionStorage.getItem(INDEX_KEY);
      // If mid-crawl we accidentally landed on 课程列表, do NOT reset — go back to current course.
      if (existing.length > 0 && idx !== null && sessionStorage.getItem(RESULTS_KEY) !== null) {
        const course = existing[Number(idx) || 0];
        if (course && (course.courseUrl || course.courseId)) {
          progress(`成绩：误入列表页，返回当前课 ${course.courseTitle || course.courseId}`);
          go(course.courseUrl || `${location.origin}/course/${course.courseId}/content`);
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
          courseUrl: item.courseUrl || `${location.origin}/course/${item.courseId}/content`
        }))
        .slice(0, MAX_COURSES);
      if (seed.length === 0) {
        progress('成绩：队列为空（未选课？），结束');
        finish([]);
        return;
      }
      progress(`成绩：准备读取 ${seed.length} 门课 · ${seed.map((c) => c.courseTitle).slice(0, 4).join('、')}`);
      startCourseQueue(seed);
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
          finish(catalogPayload());
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

      // ===== TASKS mode: build course queue from 我的课程 (first pages) =====
      // Mid-crawl: if we bounced back to the list, resume current course — never reset.
      if (mode === 'tasks') {
        const existing = readJson(QUEUE_KEY, []);
        const idxRaw = sessionStorage.getItem(INDEX_KEY);
        if (
          existing.length > 0 &&
          idxRaw !== null &&
          sessionStorage.getItem(RESULTS_KEY) !== null
        ) {
          const course = existing[Number(idxRaw) || 0];
          if (course && (course.courseId || course.courseUrl)) {
            progress(
              `任务：误入列表页，返回当前课 (${Number(idxRaw) + 1}/${existing.length}) ${course.courseTitle || course.courseId}`
            );
            go(
              course.courseUrl ||
              `${location.origin}/course/${course.courseId}/content`
            );
            return;
          }
        }
      }

      const courses = pageCourses
        .map((c) => ({
          ...c,
          courseUrl: c.courseUrl || `${location.origin}/course/${c.courseId}/content`
        }))
        .slice(0, MAX_COURSES);
      progress(`任务：从课程列表取得 ${courses.length} 门，开始逐课扫描…`);
      startCourseQueue(courses);
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
  const lastDeadlineIsPast = (text) => {
    const matches = Array.from(
      text.matchAll(/(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\s+(\d{1,2}):(\d{2})/g)
    );
    const match = matches.at(-1);
    if (!match) return false;
    const [, year, month, day, hour, minute] = match;
    const timestamp = new Date(
      Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)
    ).getTime();
    return Number.isFinite(timestamp) && timestamp <= Date.now();
  };
  const isGradeCandidate = (text) =>
    /已交|已提交|已完成|已结束|已截止|截止交付|批阅|评分/.test(text) ||
    lastDeadlineIsPast(text);
  const numberValue = (raw) => {
    const value = Number(String(raw || '').replace(/,/g, ''));
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  };
  const gradeMeta = (detailText, summaryText) => {
    const detail = normalize(detailText);
    const summary = normalize(summaryText);
    const combined = `${detail} ${summary}`;
    // Content-list chips: "已交 5分" / "已交5分" (see 学在浙大成绩 screenshots).
    const scoreMatch =
      detail.match(/最终成绩\s*[:：]?\s*(\d+(?:\.\d+)?)\s*分/) ||
      detail.match(/本次作业得分为\s*(\d+(?:\.\d+)?)\s*分/) ||
      detail.match(/教师评分\s*[:：]?\s*(\d+(?:\.\d+)?)\s*分/) ||
      summary.match(/已交(?:付)?\s*(\d+(?:\.\d+)?)\s*分/) ||
      combined.match(/已交(?:付)?\s*(\d+(?:\.\d+)?)\s*分/);
    const score = numberValue(scoreMatch?.[1]);
    const explicitMax =
      detail.match(/(?:满分|总分)\s*[:：]?\s*(\d+(?:\.\d+)?)/) ||
      detail.match(/教师评分[^()]*\(\s*(\d+(?:\.\d+)?)\s*[*×]\s*\d+(?:\.\d+)?\s*%\s*\)/);
    let maxScore = numberValue(explicitMax?.[1]);
    if (maxScore === undefined && score !== undefined) {
      const percentMatch = detail.match(/教师评分[^()]*\([^)]*?([0-9]+(?:\.[0-9]+)?)\s*%\s*\)/);
      const percent = numberValue(percentMatch?.[1]);
      if (percent && percent <= 100) maxScore = score / (percent / 100);
    }
    // Published score is enough even without maxScore.
    if (score !== undefined) {
      return { score, ...(maxScore !== undefined ? { maxScore } : {}), gradeStatus: 'published' };
    }

    const unpublished =
      /(?:最终成绩|原始成绩|教师评分)\s*[:：]?\s*(?:--|—|－)\s*分?/.test(detail) ||
      /不公布|成绩(?:尚未|暂未|未)公布/.test(detail);
    const deliverySection = detail.includes('交付历史与批改记录')
      ? detail.split('交付历史与批改记录').slice(1).join(' ')
      : '';
    const hasDelivery =
      /已交(?:付|作业)?|已提交|已交付|提交成功|交付成功/.test(combined) ||
      /20\d{2}[.-]\d{1,2}[.-]\d{1,2}\s+\d{1,2}:\d{2}/.test(deliverySection);
    const explicitlyMissing = /未交(?:作业)?|未提交|尚未提交|无交付记录|没有交付记录/.test(combined);
    const ended = /作业已经截止交付|已截止|已结束/.test(combined) || lastDeadlineIsPast(summary);

    // Submitted without a published number → 未公布 (even before deadline).
    if (hasDelivery) return { gradeStatus: 'unpublished' };
    // Closed and not submitted (e.g. 补交通道 已结束) → 错过 DDL, not a score cell.
    if (ended && (explicitlyMissing || !hasDelivery)) return { gradeStatus: 'missed' };
    if (unpublished) return { gradeStatus: 'unpublished' };
    return {};
  };

  const isHomeworkLikeText = (text) => {
    if (!text || /课件|查看文件|知识图谱|公告|录播|题库/.test(text)) return false;
    // Content list chips (学在浙大成绩 screenshots): "已交" / "已交 5分" / "已结束"
    // often have NO date on the chapter page.
    if (/结束时间|截止交付|未完成|部分完成|完成指标|已交|已提交|已结束|已截止|未交|补交/.test(text)) {
      return true;
    }
    if (/\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(text) && /Lab|Homework|作业|实验|练习|Pwn|Web|Report/i.test(text)) {
      return true;
    }
    return false;
  };
  const isGradeChipRow = (text) =>
    /已交|已提交|已交付|已结束|已截止|未交|补交|截止交付/.test(text);

  const expandContentChapters = () => {
    // Expand collapsed chapter blocks so homework rows become visible (下翻图: 第N章 ^).
    let clicks = 0;
    const tryClick = (node) => {
      if (!node || clicks >= 40) return;
      try {
        node.click();
        clicks += 1;
      } catch (_) {}
    };
    for (const node of Array.from(
      document.querySelectorAll(
        '[aria-expanded="false"], .collapsed, [class*="collapse"], [class*="expand"], i, button, span, svg'
      )
    )) {
      const label = normalize(
        node.getAttribute?.('aria-label') || node.getAttribute?.('title') || node.textContent
      );
      const cls = String(node.className || '');
      if (
        node.getAttribute?.('aria-expanded') === 'false' ||
        /展开|expand|caret|arrow|chevron|down|up/i.test(label + ' ' + cls)
      ) {
        tryClick(node);
      }
    }
    // Chapter headers like "第10章气体动理论" with a caret on the right.
    for (const el of Array.from(document.querySelectorAll('div, h3, h4, section, li, header'))) {
      if (clicks >= 40) break;
      const t = normalize(el.innerText || el.textContent);
      if (!/^第\s*\d+\s*章/.test(t) || t.length > 60) continue;
      // Prefer clicking a caret-like child, else the header itself.
      const caret =
        el.querySelector?.('[class*="arrow"], [class*="expand"], [class*="caret"], i, svg, button') ||
        el;
      tryClick(caret);
    }
  };

  const homeworkSummaries = () => {
    const mode = readMode();
    if (mode === 'grades') expandContentChapters();

    const selectors = [
      '.activity-summary[ng-switch-when="homework"]',
      '[ng-switch-when="homework"] > .activity-summary',
      '[ng-switch-when="homework"] .activity-summary',
      '[ng-switch-when="homework"]',
      '.activity-summary[ng-switch-when="exam"]',
      '.activity-summary',
      '[class*="activity"]',
      '[class*="homework"]'
    ];
    const seen = new Set();
    const direct = selectors.flatMap((selector) =>
      Array.from(document.querySelectorAll(selector))
    ).map((node) =>
      node.matches?.('.activity-summary')
        ? node
        : node.querySelector?.('.activity-summary') || node
    ).filter((node) => {
      if (!node || seen.has(node)) return false;
      const text = normalize(node.innerText || node.textContent);
      if (text.length < 2 || text.length > 400) return false;
      if (!isHomeworkLikeText(text) && !(mode === 'grades' && isGradeChipRow(text))) return false;
      // Skip huge wrappers that contain many activities.
      if (node.children && node.children.length > 20) return false;
      seen.add(node);
      return true;
    });
    if (direct.length > 0) return direct;

    // Fallback for chapter content pages (grades + tasks).
    // Grades: accept "Lab0 已交 已结束" WITHOUT a date (see 学在浙大成绩2 screenshot).
    const containers = [];
    const containerSeen = new Set();
    const candidates = Array.from(document.querySelectorAll('div, li, section, tr, a, span'));
    for (const node of candidates) {
      if (containerSeen.has(node)) continue;
      if (node.children && node.children.length > 12) continue;
      const text = normalize(node.innerText || node.textContent);
      if (text.length < 4 || text.length > 360) continue;
      const gradeRow = isGradeChipRow(text);
      if (!isHomeworkLikeText(text) && !gradeRow) continue;
      const hasDate = /\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(text);
      if (mode === 'grades') {
        if (!gradeRow && !hasDate) continue;
      } else if (!hasDate) {
        continue;
      }
      // Prefer the tightest container: skip if a child already qualifies.
      const childHit = Array.from(node.children || []).some((child) => {
        const childText = normalize(child.innerText || child.textContent);
        if (childText.length < 4 || childText.length >= text.length) return false;
        if (mode === 'grades') {
          return isGradeChipRow(childText) || (isHomeworkLikeText(childText) && /\d{4}/.test(childText));
        }
        return isHomeworkLikeText(childText) && /\d{4}/.test(childText);
      });
      if (childHit) continue;
      containerSeen.add(node);
      containers.push(node);
      if (containers.length >= 60) break;
    }
    return containers;
  };

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

  /** Map content-list chips to gradeStatus without opening homework detail. */
  const gradeStatusFromListText = (text) => {
    const t = normalize(text);
    // Skip pure courseware rows (orange 查看文件 on 下翻 screenshot).
    if (/查看文件|课件/.test(t) && !/作业|Lab|Homework|实验|补交/i.test(t)) {
      return {};
    }
    // Strict: "已交 5分" / "已交5分" badge (下翻 screenshot).
    const scoreMatch =
      t.match(/已交(?:付)?\s*(\d+(?:\.\d+)?)\s*分/) ||
      t.match(/已交(?:付)?(\d+(?:\.\d+)?)分/);
    if (scoreMatch) {
      const score = numberValue(scoreMatch[1]);
      if (score !== undefined) {
        return { score, gradeStatus: 'published' };
      }
    }
    // 已交 without a published number → 未公布. ALWAYS win over 已结束.
    // Screenshot rows are green "已交 已结束" — submitted, not missed.
    if (/已交|已提交|已交付|已完成/.test(t)) {
      return { gradeStatus: 'unpublished' };
    }
    // Only pure non-submit closed items → missed (补交通道 已结束, no 已交).
    if (/补交通道/.test(t) && /已结束|已截止/.test(t)) {
      return { gradeStatus: 'missed' };
    }
    if (/未交|未提交/.test(t) && /已结束|已截止|截止/.test(t)) {
      return { gradeStatus: 'missed' };
    }
    if (/已结束|已截止|截止交付/.test(t) && !/已交|已提交|已交付|已完成/.test(t)) {
      // Without 已交 chip, closed homework is missed — but require 作业-like title.
      if (/作业|Lab|Homework|实验|补交|通道/i.test(t)) {
        return { gradeStatus: 'missed' };
      }
    }
    return {};
  };

  /** Walk up the DOM to a row that contains BOTH homework title and status chips. */
  const fullGradeRowText = (node) => {
    let el = node;
    let fallback = normalize(node?.innerText || node?.textContent || '');
    for (let depth = 0; depth < 8 && el; depth += 1) {
      const t = normalize(el.innerText || el.textContent || '');
      if (t.length > 8 && t.length < 500) {
        const hasHw = /作业|Lab|Homework|实验|补交|通道/i.test(t);
        const hasSubmit = /已交|已提交|已交付|已完成/.test(t);
        const hasClosed = /已结束|已截止|截止交付|未交|补交/.test(t);
        // Ideal: homework + 已交 (and maybe 已结束)
        if (hasHw && hasSubmit) return t;
        if (hasHw && hasClosed) fallback = t;
      }
      if (t.length > 2500) break;
      el = el.parentElement;
    }
    return fallback;
  };

  /** 下翻: step through the page so lazy chapters mount (not only jump to end). */
  const scrollCourseContentDeep = (pass = 0) => {
    expandContentChapters();
    const maxH = Math.max(
      document.body?.scrollHeight || 0,
      document.documentElement?.scrollHeight || 0,
      2400
    );
    // First passes: step down; later: jump to bottom.
    const y = pass < 8
      ? Math.min(maxH, (pass + 1) * Math.max(500, Math.floor(maxH / 10)))
      : maxH;
    try { window.scrollTo(0, y); } catch (_) {}
    const roots = Array.from(
      document.querySelectorAll(
        '.main, main, [class*="content"], [class*="scroll"], [class*="activity"], [class*="list"], [class*="syllabus"], [class*="chapter"]'
      )
    );
    for (const el of roots) {
      try {
        if (pass < 8) {
          el.scrollTop = Math.min(el.scrollHeight || 0, (pass + 1) * 400);
        } else {
          el.scrollTop = el.scrollHeight || 999999;
        }
      } catch (_) {}
    }
  };

  /**
   * Grades-only: harvest rows that show 已交 / 已交*分 / 已结束 on the course page.
   * Does not open any learning-activity detail URL.
   */
  const extractGradesOnContentPage = (course) => {
    expandContentChapters();
    const found = [];
    const seenTitle = new Set();
    const pushGrade = (title, text) => {
      // Always re-resolve status from the richest row text (title + chips).
      const row = normalize(text);
      if (/课件|查看文件/.test(row) && !/作业|Lab|Homework|实验|补交/i.test(row)) return;
      const clean = cleanTaskTitle(title, row);
      if (!clean || seenTitle.has(clean)) return;
      // Ignore pure chapter headers
      if (/^第\s*\d+\s*章[^作]*$/.test(clean) && !/作业/.test(clean)) return;
      const statusMeta = gradeStatusFromListText(row);
      if (!statusMeta.gradeStatus) return;
      seenTitle.add(clean);
      found.push({
        courseId: course.courseId,
        courseTitle: course.courseTitle,
        courseUrl: course.courseUrl || `${location.origin}/course/${course.courseId}/content`,
        title: clean,
        text: row.slice(0, 400),
        ...statusMeta
      });
    };

    // 1) DOM activity rows — use full row text so 已交 chips are not lost.
    for (const summary of homeworkSummaries()) {
      const row = fullGradeRowText(summary);
      if (!/已交|已结束|未交|补交|作业|Lab|Homework/i.test(row)) continue;
      const explicitTitle = normalize(
        summary.querySelector(
          '.title, .activity-title, [ng-bind*="title"], h3, h4, a[href*="learning-activity"], a[href*="full-screen"]'
        )?.textContent
      );
      pushGrade(explicitTitle || row, row);
    }

    // 2) Line-scan with look-ahead: merge title line + following chip line(s).
    //    Fixes false "missed" when 已交 and 已结束 split across lines.
    const lines = String(document.body?.innerText || '')
      .split(/\n+/)
      .map((line) => normalize(line))
      .filter((line) => line.length >= 2 && line.length <= 220);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const next = lines[i + 1] || '';
      const next2 = lines[i + 2] || '';
      const merged = normalize([line, next, next2].join(' '));
      // Prefer lines that look like homework titles
      const looksHw = /作业|Lab|Homework|实验|补交|通道/i.test(line) || /作业|Lab|Homework|实验|补交|通道/i.test(merged);
      const hasStatus = /已交|已结束|未交|补交/.test(merged);
      if (!looksHw || !hasStatus) continue;
      if (/课件|查看文件/.test(merged) && !/作业/.test(merged)) continue;
      const title = cleanTaskTitle(line, merged) || cleanTaskTitle(merged, merged);
      pushGrade(title, merged);
    }
    return found;
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

  const advanceCourseOrFinish = (results) => {
    const mode = readMode();
    const queue = readJson(QUEUE_KEY, []);
    const index = Number(sessionStorage.getItem(INDEX_KEY) || 0);
    const nextIndex = index + 1;
    if (nextIndex < queue.length) {
      const next = queue[nextIndex];
      const tag = mode === 'grades' ? '成绩' : '任务';
      progress(`${tag}：下一门课 (${nextIndex + 1}/${queue.length}) ${next.courseTitle || next.courseId}`);
      sessionStorage.setItem(INDEX_KEY, String(nextIndex));
      // Always stay on course content, never /user/courses mid-crawl.
      // go() is queued after progress so the hop is not cancelled by zju-progress.
      go(next.courseUrl || `${location.origin}/course/${next.courseId}/content`);
      return;
    }
    if (mode === 'grades') {
      progress(`成绩：全部课程扫完，回报 ${(results || []).length} 条`);
    } else {
      progress(`任务：全部课程扫完，回报 ${(results || []).length} 条原始记录`);
    }
    finish(results || readJson(RESULTS_KEY, []));
  };

  const scanCourse = () => {
    const queue = readJson(QUEUE_KEY, []);
    const index = Number(sessionStorage.getItem(INDEX_KEY) || 0);
    const course = queue[index];
    if (!course) {
      finish(readJson(RESULTS_KEY, []));
      return;
    }
    let attempts = 0;
    const inspect = () => {
      const mode = readMode();

      // Never process learning-activity detail pages in either mode.
      if (/learning-activity/.test(location.pathname + location.hash)) {
        go(course.courseUrl || `${location.origin}/course/${course.courseId}/content`);
        return;
      }

      // If we left the course (e.g. sidebar click), bounce back to content — do not re-scan list.
      if (!location.pathname.includes(`/course/${course.courseId}`)) {
        const bounceKey = 'fuckddl:zju:bounce';
        const bounce = Number(sessionStorage.getItem(bounceKey) || '0') + 1;
        sessionStorage.setItem(bounceKey, String(bounce));
        const tag = mode === 'grades' ? '成绩' : '任务';
        if (bounce > 6) {
          progress(`${tag}：课程页反复跳转，跳过 ${course.courseTitle || course.courseId}`);
          sessionStorage.removeItem(bounceKey);
          advanceCourseOrFinish(readJson(RESULTS_KEY, []));
          return;
        }
        if (bounce === 1 || mode === 'grades') {
          progress(`${tag}：页面离开课程，返回 ${course.courseTitle || course.courseId}`);
        }
        go(course.courseUrl || `${location.origin}/course/${course.courseId}/content`);
        return;
      }
      try { sessionStorage.removeItem('fuckddl:zju:bounce'); } catch (_) {}

      const bodyText = document.body?.innerText || '';
      const courseReady = Boolean(
        document.querySelector(`a[href="/course/${course.courseId}/homework"]`) ||
        document.querySelector(`a[href*="/course/${course.courseId}/"]`) ||
        document.querySelector('.activity-summary') ||
        /章节|作业|已交|已结束|结束时间|类型|完成指标|Lab|Homework/i.test(bodyText)
      );

      // ========== GRADES: content page only, scroll in-page, never open list ==========
      if (mode === 'grades') {
        if (!courseReady && attempts < 16) {
          attempts += 1;
          if (attempts === 1) {
            progress(`成绩：打开 ${course.courseTitle || course.courseId}，等待内容…`);
          }
          setTimeout(inspect, 350);
          return;
        }
        const scrollKey = `fuckddl:zju:grade-scroll:${course.courseId}`;
        const lastCountKey = `fuckddl:zju:grade-last:${course.courseId}`;
        const stableKey = `fuckddl:zju:grade-stable:${course.courseId}`;
        const scrollRound = Number(sessionStorage.getItem(scrollKey) || '0');
        // Stay on 章节 content; do NOT click 作业 tab (was navigating away on some pages).
        expandContentChapters();
        scrollCourseContentDeep(scrollRound);
        let grades = extractGradesOnContentPage(course);
        const lastCount = Number(sessionStorage.getItem(lastCountKey) || '0');
        const stableRounds = grades.length === lastCount && grades.length > 0
          ? Number(sessionStorage.getItem(stableKey) || '0') + 1
          : 0;
        sessionStorage.setItem(lastCountKey, String(grades.length));
        sessionStorage.setItem(stableKey, String(stableRounds));
        const needMore =
          scrollRound < 16 &&
          (scrollRound < 8 || grades.length === 0 || grades.length > lastCount || stableRounds < 2);
        if (needMore) {
          sessionStorage.setItem(scrollKey, String(scrollRound + 1));
          if (scrollRound === 0) {
            progress(`成绩：${course.courseTitle || course.courseId} 页内下翻+展开章节…`);
          } else if (scrollRound % 3 === 0) {
            const pub = grades.filter((g) => g.gradeStatus === 'published').length;
            const unp = grades.filter((g) => g.gradeStatus === 'unpublished').length;
            const mis = grades.filter((g) => g.gradeStatus === 'missed').length;
            progress(
              `成绩：下翻中… 第${scrollRound + 1}轮 · 识别 ${grades.length} 条（出分${pub}/未公布${unp}/错过${mis}）`
            );
          }
          setTimeout(inspect, 480);
          return;
        }
        sessionStorage.removeItem(scrollKey);
        sessionStorage.removeItem(lastCountKey);
        sessionStorage.removeItem(stableKey);
        try { window.scrollTo(0, 0); } catch (_) {}
        expandContentChapters();
        for (let p = 0; p < 6; p += 1) scrollCourseContentDeep(p + 8);
        grades = extractGradesOnContentPage(course);

        const results = readJson(RESULTS_KEY, []);
        const keys = new Set(results.map((item) => `${item.courseId}|${item.title}`));
        let added = 0;
        for (const g of grades) {
          const key = `${g.courseId}|${g.title}`;
          if (keys.has(key)) continue;
          keys.add(key);
          results.push(g);
          added += 1;
        }
        sessionStorage.setItem(RESULTS_KEY, JSON.stringify(results.slice(0, 300)));
        const pub = grades.filter((g) => g.gradeStatus === 'published').length;
        const unp = grades.filter((g) => g.gradeStatus === 'unpublished').length;
        const mis = grades.filter((g) => g.gradeStatus === 'missed').length;
        const sample = grades.slice(0, 4).map((g) =>
          `${g.title}:${g.gradeStatus}${g.score != null ? '=' + g.score : ''}`
        ).join(' / ');
        progress(
          `成绩：${course.courseTitle || course.courseId} → +${added} 条（本课${grades.length}=出分${pub}/未公布${unp}/错过${mis}，累计${results.length}）` +
          (sample ? ` · ${sample}` : grades.length === 0 ? ' · 未识别到已交/已结束' : '')
        );
        advanceCourseOrFinish(results);
        return;
      }

      // ========== TASKS: simple summary crawl only ==========
      // Light expand so Lab rows are visible; no grade tab-clicking / long scroll.
      if (attempts === 0) {
        progress(`任务：打开 ${course.courseTitle || course.courseId}…`);
        try { expandContentChapters(); } catch (_) {}
      }
      const summaries = homeworkSummaries();
      // Empty courses (思政等) skip quickly so the whole sync finishes.
      // courseReady false: wait a bit for SPA; then skip.
      // courseReady true + no summaries: short settle, then +0 and advance.
      const maxWait = courseReady ? 6 : 10;
      if (!courseReady || (summaries.length === 0 && attempts < 4)) {
        attempts += 1;
        if (attempts < maxWait) {
          if (attempts === 4 || attempts === 8) {
            progress(
              `任务：等待 ${course.courseTitle || course.courseId} 内容… (${attempts}/${maxWait})`
            );
          }
          setTimeout(inspect, 280);
        } else {
          progress(`任务：${course.courseTitle || course.courseId} 无作业，跳过`);
          advanceCourseOrFinish(readJson(RESULTS_KEY, []));
        }
        return;
      }

      const tasks = summaries.flatMap((summary) => {
        const ownTxt = normalize(summary.innerText || summary.textContent);
        const container = summary.closest?.('[class*="activity"], li, tr, section, div') || summary.parentElement || summary;
        const containerText = normalize(container.innerText || container.textContent);
        // Prefer container when it carries the deadline line.
        const text = /结束时间|时间\s*[:：]|已交|已结束|未交|\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(ownTxt)
          ? ownTxt
          : containerText;
        if (/课件|查看文件|知识图谱|公告/.test(text) && !/作业|Lab|Homework|实验/i.test(text)) {
          return [];
        }
        const explicitTitle = normalize(
          summary.querySelector(
            '.title, .activity-title, [ng-bind*="title"], h3, h4, a[href*="learning-activity"], a[href*="full-screen"]'
          )?.textContent
        );
        const title = cleanTaskTitle(explicitTitle, text);
        if (!title) return [];
        // Need a deadline somewhere or it is not a DDL task.
        if (!/\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(text) && !/\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(title)) {
          return [];
        }
        const activity = activityLink(container, course);
        return [{
          courseId: course.courseId,
          courseTitle: course.courseTitle,
          courseUrl: course.courseUrl || `${location.origin}/course/${course.courseId}/content`,
          ...activity,
          title,
          text: text.slice(0, 400)
        }];
      });
      const results = readJson(RESULTS_KEY, []);
      const keys = new Set(results.map((item) =>
        `${item.courseId}|${item.title}|${item.text}`
      ));
      let added = 0;
      for (const task of tasks) {
        const key = `${task.courseId}|${task.title}|${task.text}`;
        if (keys.has(key)) continue;
        keys.add(key);
        results.push(task);
        added += 1;
      }
      sessionStorage.setItem(RESULTS_KEY, JSON.stringify(results.slice(0, 200)));
      progress(`任务：${course.courseTitle || course.courseId} → +${added} 条（累计${results.length}）`);
      advanceCourseOrFinish(results);
    };
    inspect();
  };

  const scanActivity = () => {
    const activityQueue = readJson(ACTIVITY_QUEUE_KEY, []);
    const index = Number(sessionStorage.getItem(ACTIVITY_INDEX_KEY) || 0);
    const activity = activityQueue[index];
    if (!activity) {
      finish(readJson(RESULTS_KEY, []));
      return;
    }
    let attempts = 0;
    const inspect = () => {
      const detailText = normalize(document.body?.innerText);
      const expectedIdLoaded = activityIdFromUrl(location.href) === activity.activityId;
      const titlePrefix = normalize(activity.title).slice(0, 12);
      const pageReady = expectedIdLoaded && Boolean(
        (titlePrefix && detailText.includes(titlePrefix)) ||
        /作业内容|我的作业|最终成绩|交付历史与批改记录/.test(detailText)
      );
      if (!pageReady && attempts < 12) {
        attempts += 1;
        setTimeout(inspect, 250);
        return;
      }

      const results = readJson(RESULTS_KEY, []);
      const resultIndex = results.findIndex((item) =>
        item.courseId === activity.courseId && item.activityId === activity.activityId
      );
      if (pageReady && resultIndex >= 0) {
        results[resultIndex] = {
          ...results[resultIndex],
          ...gradeMeta(detailText, results[resultIndex].text)
        };
        sessionStorage.setItem(RESULTS_KEY, JSON.stringify(results.slice(0, 200)));
      }

      const nextIndex = index + 1;
      if (nextIndex >= activityQueue.length) {
        finish(results);
        return;
      }
      sessionStorage.setItem(ACTIVITY_INDEX_KEY, String(nextIndex));
      const next = activityQueue[nextIndex];
      try {
        const nextUrl = new URL(next.activityUrl, location.origin);
        if (nextUrl.origin === location.origin && nextUrl.pathname === location.pathname) {
          go(nextUrl.href);
          setTimeout(scanActivity, 450);
          return;
        }
      } catch {
        // Let normal navigation validation handle malformed values.
      }
      go(next.activityUrl);
    };
    inspect();
  };

  const ensureQueueFromSeed = () => {
    if (sessionStorage.getItem(QUEUE_KEY)) return true;
    const seed = readJson(COURSE_SEED_KEY, []);
    if (seed.length === 0) return false;
    sessionStorage.setItem(QUEUE_KEY, JSON.stringify(seed));
    sessionStorage.setItem(RESULTS_KEY, sessionStorage.getItem(RESULTS_KEY) || '[]');
    sessionStorage.setItem(INDEX_KEY, sessionStorage.getItem(INDEX_KEY) || '0');
    sessionStorage.setItem(ACTIVITY_QUEUE_KEY, sessionStorage.getItem(ACTIVITY_QUEUE_KEY) || '[]');
    sessionStorage.setItem(ACTIVITY_INDEX_KEY, sessionStorage.getItem(ACTIVITY_INDEX_KEY) || '0');
    return true;
  };

  afterDomReady(() => {
    if (location.pathname === '/user/courses' || location.pathname === '/user/index') {
      const modeParam = new URLSearchParams(location.search).get('fuckddl-sync');
      // Query param always wins when present (fresh sync). Otherwise keep session mode.
      if (modeParam === 'grades' || modeParam === 'tasks' || modeParam === 'courses') {
        sessionStorage.setItem(MODE_KEY, modeParam);
      } else if (!sessionStorage.getItem(MODE_KEY)) {
        sessionStorage.setItem(MODE_KEY, 'tasks');
      }
      scanCourses();
      return;
    }
    // Course content pages
    if (/^\/course\/\d+/.test(location.pathname)) {
      if (/learning-activity/.test(location.pathname + location.hash)) {
        // Bounce back to content — never scrape detail pages.
        const queue = readJson(QUEUE_KEY, []);
        const index = Number(sessionStorage.getItem(INDEX_KEY) || 0);
        const course = queue[index];
        if (course) {
          go(course.courseUrl || `${location.origin}/course/${course.courseId}/content`);
        }
        return;
      }
      if (!ensureQueueFromSeed()) return;
      if (!sessionStorage.getItem(MODE_KEY)) sessionStorage.setItem(MODE_KEY, 'tasks');
      // Grades/tasks both use /content for summaries.
      if (!/\/content/.test(location.pathname)) {
        const queue = readJson(QUEUE_KEY, []);
        const index = Number(sessionStorage.getItem(INDEX_KEY) || 0);
        const course = queue[index];
        const id = course?.courseId || (location.pathname.match(/\/course\/(\d+)/) || [])[1];
        if (id) {
          go(`${location.origin}/course/${id}/content`);
          return;
        }
      }
      scanCourse();
      return;
    }
  });
})();
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
    let clear = "['fuckddl:zju:queue','fuckddl:zju:results','fuckddl:zju:index',\
        'fuckddl:zju:activity-queue','fuckddl:zju:activity-index',\
        'fuckddl:zju:course-seed','fuckddl:zju:courses-accum','fuckddl:zju:courses-page',\
        'fuckddl:zju:courses-wait','fuckddl:zju:courses-phase','fuckddl:zju:courses-fp',\
        'fuckddl:zju:courses-method','fuckddl:zju:courses-size']\
        .forEach((k) => sessionStorage.removeItem(k));\
        try { Object.keys(sessionStorage).forEach((k) => {\
          if (k.indexOf('fuckddl:zju:grade-') === 0) sessionStorage.removeItem(k);\
        }); } catch (_) {}";
    if mode == "grades" {
        let queue = courses
            .iter()
            .filter_map(|course| {
                let course = sanitized_course_selection(course)?;
                Some(serde_json::json!({
                    "courseId": course.course_id,
                    "courseTitle": course.course_title,
                    "courseUrl": course.course_url,
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
                 sessionStorage.setItem('fuckddl:zju:queue', {literal}); \
                 sessionStorage.setItem('fuckddl:zju:results', '[]'); \
                 sessionStorage.setItem('fuckddl:zju:index', '0'); \
                 sessionStorage.setItem('fuckddl:zju:activity-queue', '[]'); \
                 sessionStorage.setItem('fuckddl:zju:activity-index', '0'); \
                 }} catch (_) {{}}"
            ));
        }
        return Ok(format!(
            "try {{ \
             if (!sessionStorage.getItem('fuckddl:zju:queue')) {{ \
               sessionStorage.setItem('fuckddl:zju:mode', 'grades'); \
               sessionStorage.setItem('fuckddl:zju:course-seed', {literal}); \
               sessionStorage.setItem('fuckddl:zju:queue', {literal}); \
               sessionStorage.setItem('fuckddl:zju:results', '[]'); \
               sessionStorage.setItem('fuckddl:zju:index', '0'); \
               sessionStorage.setItem('fuckddl:zju:activity-queue', '[]'); \
               sessionStorage.setItem('fuckddl:zju:activity-index', '0'); \
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
    fn course_summary_uses_the_three_explicit_grade_states() {
        assert!(EXTRACT_SCRIPT.contains("summary.match(/已交(?:付)?\\s*"));
        assert!(EXTRACT_SCRIPT.contains("if (hasDelivery) return { gradeStatus: 'unpublished' }"));
        assert!(EXTRACT_SCRIPT.contains("if (ended && (explicitlyMissing || !hasDelivery))"));
        assert!(EXTRACT_SCRIPT.contains("MAX_COURSES = 20"));
        assert!(EXTRACT_SCRIPT.contains("isHomeworkLikeText"));
        assert!(EXTRACT_SCRIPT.contains("结束时间"));
        assert!(EXTRACT_SCRIPT.contains("MODE_KEY"));
        assert!(EXTRACT_SCRIPT.contains("COURSE_SEED_KEY"));
        assert!(EXTRACT_SCRIPT.contains("zju-courses"));
        assert!(EXTRACT_SCRIPT.contains("mode === 'courses'"));
        assert!(EXTRACT_SCRIPT.contains("semester"));
        assert!(EXTRACT_SCRIPT.contains("advanceCourseOrFinish"));
        assert!(EXTRACT_SCRIPT.contains("enqueueHref"));
        assert!(EXTRACT_SCRIPT.contains("const go = (url)"));
        assert!(EXTRACT_SCRIPT.contains("isGradeChipRow"));
        assert!(EXTRACT_SCRIPT.contains("learning-activity"));
        assert!(EXTRACT_SCRIPT.contains("pageIndex"));
        assert!(EXTRACT_SCRIPT.contains("误入列表页"));
        assert!(EXTRACT_SCRIPT.contains("任务："));
        assert!(EXTRACT_SCRIPT.contains("从课程列表取得"));
        assert!(EXTRACT_SCRIPT.contains("无作业，跳过"));
        // Course hop must be queued after progress (not a raw location.href race).
        assert!(EXTRACT_SCRIPT.contains(
            "go(next.courseUrl || `${location.origin}/course/${next.courseId}/content`)"
        ));
        assert!(EXTRACT_SCRIPT.contains("scrollCatalogToPager"));
        assert!(EXTRACT_SCRIPT.contains("zju-progress"));
        assert!(EXTRACT_SCRIPT.contains("翻页"));
        assert!(EXTRACT_SCRIPT.contains("页码输入"));
        assert!(EXTRACT_SCRIPT.contains("catalogPageUrl"));
        assert!(EXTRACT_SCRIPT.contains("hard-reload"));
        assert!(EXTRACT_SCRIPT.contains("openItemsPerPageMenu"));
        assert!(EXTRACT_SCRIPT.contains("pickLargestPageSizeOption"));
        assert!(EXTRACT_SCRIPT.contains("findItemsPerPageTrigger"));
        assert!(EXTRACT_SCRIPT.contains("项/页"));
        assert!(EXTRACT_SCRIPT.contains("cleanTaskTitle"));
        assert!(EXTRACT_SCRIPT.contains("extractGradesOnContentPage"));
        assert!(EXTRACT_SCRIPT.contains("gradeStatusFromListText"));
        assert!(EXTRACT_SCRIPT.contains("成绩："));
        assert!(EXTRACT_SCRIPT.contains("learning-activity"));
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
        assert!(grades.as_str().contains("/course/99089/content"));
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
