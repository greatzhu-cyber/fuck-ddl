use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{
    webview::PageLoadEvent, AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
};
use url::Url;

const PINTIA_WINDOW_LABEL: &str = "pintia-login";
const PINTIA_ACTIVE_URL: &str = "https://pintia.cn/problem-sets/active";
const PINTIA_LOGIN_URL: &str = "https://pintia.cn/auth/login?redirect=/problem-sets/active";
const MAX_PAYLOAD_BYTES: usize = 512 * 1024;
const MAX_RETURNED_CARDS: usize = 200;
const CLEAR_PINTIA_STORAGE_SCRIPT: &str =
    "window.localStorage.clear(); window.sessionStorage.clear();";

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PintiaSyncOptions {
    /// `tasks` = active problem-set list only (fast).
    /// `grades` = ended-set detail scan (slow, paced).
    mode: Option<String>,
    since_date: Option<String>,
    max_items: Option<usize>,
    #[serde(default)]
    known_final_ids: Vec<String>,
}

fn pintia_sync_mode(raw: Option<&str>) -> &'static str {
    match raw {
        Some("grades") | Some("grades-v2") => "grades-v2",
        _ => "tasks-v1",
    }
}

fn pintia_sync_url(options: Option<PintiaSyncOptions>) -> Result<String, String> {
    let options = options.unwrap_or_default();
    let sync_mode = pintia_sync_mode(options.mode.as_deref());
    let since_date = options.since_date.filter(|value| {
        value.len() == 10
            && value.bytes().enumerate().all(|(index, byte)| {
                matches!(index, 4 | 7) && byte == b'-'
                    || !matches!(index, 4 | 7) && byte.is_ascii_digit()
            })
    });
    // Keep grade batches small — large detail crawls OOM/crash WebView2.
    let max_items = options.max_items.unwrap_or(50).clamp(10, 100);
    let known_final_ids = options
        .known_final_ids
        .into_iter()
        .filter(|id| {
            !id.is_empty() && id.len() <= 32 && id.bytes().all(|byte| byte.is_ascii_digit())
        })
        .take(200)
        .collect::<Vec<_>>()
        .join(",");
    let mut url = Url::parse(PINTIA_ACTIVE_URL).map_err(|_| "pintia-url-invalid".to_string())?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("fuckddl-sync", sync_mode);
        if sync_mode == "grades-v2" {
            query.append_pair("maxItems", &max_items.to_string());
            if let Some(since_date) = since_date {
                query.append_pair("sinceDate", &since_date);
            }
            if !known_final_ids.is_empty() {
                query.append_pair("knownFinalIds", &known_final_ids);
            }
        }
    }
    Ok(url.into())
}
const EXTRACT_SCRIPT: &str = r#"
(() => {
  if (window.top !== window) return;
  if (location.origin !== 'https://pintia.cn') return;
  const STORAGE_KEY = '__fuckddl_pintia_grade_scan_v1__';
  const RESULT_KEY = '__fuckddl_pintia_result_v1__';
  const CURSOR_KEY = '__fuckddl_pintia_grade_cursor_v1__';
  const CURSOR_SCOPE_KEY = '__fuckddl_pintia_grade_cursor_scope_v1__';
  const params = new URLSearchParams(location.search);
  // Persist mode so SPA redirects that drop query still finish correctly.
  const queryMode = params.get('fuckddl-sync');
  if (queryMode === 'grades-v2' || queryMode === 'tasks-v1') {
    try { sessionStorage.setItem('__fuckddl_pintia_mode_v1__', queryMode); } catch (_) {}
  }
  let storedMode = '';
  try { storedMode = sessionStorage.getItem('__fuckddl_pintia_mode_v1__') || ''; } catch (_) {}
  const SYNC_MODE = (queryMode === 'grades-v2' || storedMode === 'grades-v2') ? 'grades' : 'tasks';
  const MAX_GRADE_ITEMS = Math.min(
    100,
    Math.max(10, Number(params.get('maxItems') || 50))
  );
  const SCAN_SINCE_DATE = /^\d{4}-\d{2}-\d{2}$/.test(params.get('sinceDate') || '')
    ? params.get('sinceDate')
    : '';
  const KNOWN_FINAL_IDS = new Set(
    (params.get('knownFinalIds') || '').split(',').filter((id) => /^\d+$/.test(id))
  );
  // Keep grade crawl light — 20 * 2.2s + pages was crashing/timing out WebView2.
  const MAX_DETAIL_ITEMS_PER_SYNC = 8;
  const MAX_LIST_PAGES = 8;
  const MAX_CARD_TEXT = 512;
  const DETAIL_DELAY_MS = 1600;
  const LIST_PAGE_DELAY_MS = 900;
  const ACTIVE_PATH = '/problem-sets/active';
  const ALL_PATH = '/problem-sets/all';
  const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
  const readState = () => {
    try {
      return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
    } catch (_) {
      return null;
    }
  };
  const writeState = (state) => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch (_) {
      return false;
    }
  };
  const clearState = () => {
    try {
      sessionStorage.removeItem(STORAGE_KEY);
      sessionStorage.removeItem('__fuckddl_pintia_mode_v1__');
    } catch (_) {}
  };
  // Keep payload small: large custom-scheme URLs crash WebView2.
  const reportCards = (cards) => {
    let compact = (cards || []).slice(0, 120).map((card) => ({
      href: card.href,
      text: String(card.text || '').slice(0, MAX_CARD_TEXT),
      ...(card.sourceUrl ? { sourceUrl: card.sourceUrl } : {}),
      ...(card.startedAt ? { startedAt: card.startedAt } : {}),
      ...(card.score !== undefined ? { score: card.score } : {}),
      ...(card.maxScore !== undefined ? { maxScore: card.maxScore } : {}),
      ...(card.rank ? { rank: card.rank } : {}),
      ...(card.gradeStatus ? { gradeStatus: card.gradeStatus } : {})
    }));
    let encoded = encodeURIComponent(JSON.stringify(compact));
    if (encoded.length > 90000) {
      compact = compact
        .filter((card) => card.gradeStatus || /关闭时间|截止时间/.test(card.text || ''))
        .map((card) => ({ ...card, text: String(card.text || '').slice(0, 180) }))
        .slice(0, 60);
      encoded = encodeURIComponent(JSON.stringify(compact));
    }
    if (encoded.length > 120000) {
      location.href = 'fuckddl-sync://pintia-extract-failed';
      return;
    }
    location.href = `fuckddl-sync://pintia?payload=${encoded}`;
  };
  const fail = (reason = 'pintia-extract-failed') => {
    clearState();
    try { sessionStorage.removeItem(RESULT_KEY); } catch (_) {}
    location.href = `fuckddl-sync://${reason}`;
  };
  const problemSetId = (href) => {
    try {
      return new URL(href, location.origin).pathname
        .match(/^\/problem-sets\/(\d+)(?:\/|$)/)?.[1] || null;
    } catch (_) {
      return null;
    }
  };
  const canonicalCardHref = (href) => {
    const id = problemSetId(href);
    return id ? `${location.origin}/problem-sets/${id}/overview` : null;
  };
  const detailHref = (href) => {
    const id = problemSetId(href);
    return id ? `${location.origin}/problem-sets/${id}/exam/overview` : null;
  };
  const cardTextForLink = (link) => {
    const own = normalize(link.textContent);
    if (/(关闭时间|截止时间)/.test(own)) return own.slice(0, MAX_CARD_TEXT);
    // PTA often puts deadline outside the <a>; climb a few parents only.
    let node = link.parentElement;
    for (let depth = 0; node && depth < 4; depth += 1, node = node.parentElement) {
      const text = normalize(node.innerText || node.textContent);
      if (text.length > MAX_CARD_TEXT * 2) continue;
      if (/(关闭时间|截止时间)/.test(text)) return text.slice(0, MAX_CARD_TEXT);
    }
    return own.slice(0, MAX_CARD_TEXT);
  };
  const collectVisibleCards = () => {
    const seen = new Set();
    return Array.from(document.querySelectorAll('a[href*="/problem-sets/"]'))
      .flatMap((link) => {
        const href = canonicalCardHref(link.href);
        const id = href && problemSetId(href);
        if (!id || seen.has(id)) return [];
        seen.add(id);
        return [{ href, text: cardTextForLink(link) }];
      });
  };
  const mergeCards = (current, additions) => {
    const result = [];
    const positions = new Map();
    [...(current || []), ...(additions || [])].forEach((card) => {
      const id = problemSetId(card.href);
      if (!id) return;
      if (positions.has(id)) {
        const position = positions.get(id);
        if ((card.text || '').length > (result[position].text || '').length) {
          result[position] = card;
        }
        return;
      }
      positions.set(id, result.length);
      result.push(card);
    });
    return result;
  };
  const hasExplicitEmptyState = () => Array.from(
    document.querySelectorAll('body *')
  ).some((node) => node.children.length === 0 &&
    normalize(node.textContent) === '\u65e0\u9898\u76ee\u96c6');
  const pageHasSessionError = () => {
    const pageText = normalize(document.body?.innerText);
    return pageText.includes('\u7528\u6237\u4e0d\u5b58\u5728');
  };
  const pageHasRateLimit = () => {
    const pageText = normalize(document.body?.innerText);
    return pageText.includes('\u60a8\u8bbf\u95ee\u5f97\u592a\u5feb\u5566');
  };
  const enabledNextPage = () => Array.from(
    document.querySelectorAll('button, a, [role="button"]')
  ).find((node) => {
    if (normalize(node.textContent) !== '\u4e0b\u4e00\u9875') return false;
    if (node.disabled || node.getAttribute('aria-disabled') === 'true') return false;
    return !String(node.className || '').toLowerCase().includes('disabled');
  });
  const allProblemSetsControl = () => Array.from(
    document.querySelectorAll('a, button, [role="tab"]')
  ).find((node) => normalize(node.textContent) === '\u6240\u6709\u9898\u76ee\u96c6');
  const finish = (state) => {
    // tasks: active list only (fast, small payload).
    // grades: active (for exclusion) + limited detail cards.
    const cards = SYNC_MODE === 'tasks'
      ? (state.activeCards || []).slice(0, 100)
      : mergeCards(
          (state.activeCards || []).slice(0, 20),
          state.gradeCards
        ).slice(0, 120);
    clearState();
    reportCards(cards);
  };
  const prepareGradeQueue = (state) => {
    const activeIds = new Set((state.activeCards || [])
      .map((card) => problemSetId(card.href)).filter(Boolean));
    const candidates = (state.allCards || [])
      .filter((card) => {
        const id = problemSetId(card.href);
        return !activeIds.has(id) && !KNOWN_FINAL_IDS.has(id);
      })
      .slice(0, MAX_GRADE_ITEMS);
    let cursor = 0;
    try {
      const scope = `${SCAN_SINCE_DATE}|${MAX_GRADE_ITEMS}`;
      if (localStorage.getItem(CURSOR_SCOPE_KEY) !== scope) {
        localStorage.setItem(CURSOR_SCOPE_KEY, scope);
        localStorage.setItem(CURSOR_KEY, '0');
      }
      cursor = Number(localStorage.getItem(CURSOR_KEY) || 0);
    } catch (_) {
      cursor = 0;
    }
    const start = candidates.length > 0 && Number.isFinite(cursor)
      ? Math.max(0, Math.floor(cursor)) % candidates.length
      : 0;
    const batchSize = Math.min(MAX_DETAIL_ITEMS_PER_SYNC, candidates.length);
    state.queue = Array.from(
      { length: batchSize },
      (_, offset) => candidates[(start + offset) % candidates.length]
    );
    state.cursorStart = start;
    state.candidateCount = candidates.length;
    state.gradeCards = [];
    state.detailIndex = 0;
    state.phase = 'detail';
    if (!writeState(state)) return fail();
    if (state.queue.length === 0) return finish(state);
    setTimeout(
      () => location.replace(detailHref(state.queue[0].href)),
      DETAIL_DELAY_MS
    );
  };
  const collectList = (kind) => {
    let attempts = 0;
    let stable = 0;
    const poll = () => {
      if (pageHasSessionError()) return fail('pintia-session-corrupt');
      const state = readState();
      if (!state || state.phase !== kind) return fail();
      const key = kind === 'active' ? 'activeCards' : 'allCards';
      const before = (state[key] || []).length;
      state[key] = mergeCards(state[key], collectVisibleCards());
      const after = state[key].length;
      stable = after === before ? stable + 1 : 0;
      attempts += 1;
      if (!writeState(state)) return fail();

      if (kind === 'all') {
        const activeIds = new Set((state.activeCards || [])
          .map((card) => problemSetId(card.href)).filter(Boolean));
        const endedCount = state.allCards
          .filter((card) => !activeIds.has(problemSetId(card.href))).length;
        if (endedCount >= MAX_GRADE_ITEMS) return prepareGradeQueue(state);
      }

      const ready = after > 0 || hasExplicitEmptyState();
      if (!ready && attempts < 40) {
        setTimeout(poll, 300);
        return;
      }
      if (!ready) return fail();

      window.scrollTo(0, document.documentElement.scrollHeight);
      if (stable < 4 && attempts < 50) {
        setTimeout(poll, 300);
        return;
      }

      if (kind === 'active') {
        if (SYNC_MODE === 'tasks') return finish(state);
        state.phase = 'all';
        state.allCards = [];
        state.listPages = 0;
        if (!writeState(state)) return fail();
        const control = allProblemSetsControl();
        if (control?.tagName === 'A' && control.href) {
          setTimeout(() => { location.href = control.href; }, LIST_PAGE_DELAY_MS);
        } else if (control) {
          setTimeout(() => {
            control.click();
            setTimeout(() => collectList('all'), 400);
          }, LIST_PAGE_DELAY_MS);
        } else {
          setTimeout(
            () => { location.href = `${location.origin}${ALL_PATH}`; },
            LIST_PAGE_DELAY_MS
          );
        }
        return;
      }

      const next = enabledNextPage();
      if (next && (state.listPages || 0) < MAX_LIST_PAGES) {
        state.listPages = (state.listPages || 0) + 1;
        if (!writeState(state)) return fail();
        setTimeout(() => {
          next.click();
          setTimeout(() => collectList('all'), 400);
        }, LIST_PAGE_DELAY_MS);
        return;
      }
      prepareGradeQueue(state);
    };
    poll();
  };
  const exactNumber = (value) => {
    const match = normalize(value).match(/^(\d+(?:\.\d+)?)$/);
    return match ? Number(match[1]) : null;
  };
  const shanghaiIso = (match) => match
    ? `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}T${match[4].padStart(2, '0')}:${match[5].padStart(2, '0')}:${(match[6] || '00').padStart(2, '0')}+08:00`
    : null;
  const totalScore = () => {
    const rows = Array.from(document.querySelectorAll('tr, [role="row"]'));
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('th, td, [role="cell"]'));
      if (!cells.some((cell) => normalize(cell.textContent) === '\u603b\u8ba1')) continue;
      const numbers = cells.map((cell) => exactNumber(cell.textContent))
        .filter((value) => value !== null);
      if (numbers.length >= 2) {
        return { score: numbers[0], maxScore: numbers[numbers.length - 1] };
      }
    }
    return null;
  };
  const gradeFromPage = (base) => {
    const text = normalize(document.body?.innerText);
    const startMatch = text.match(
      /\u7b54\u9898\u5f00\u59cb\u65f6\u95f4\s*(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/
    );
    const total = totalScore();
    const metricScore = text.match(/(\d+(?:\.\d+)?)\s*\u5206\u6570(?:\s|$)/);
    const rankMatch = text.match(/(\d+)\s*\/\s*(\d+)\s*\u6392\u540d(?:\s|$)/);
    const score = total?.score ?? (metricScore ? Number(metricScore[1]) : null);
    const maxScore = total?.maxScore ?? null;
    const closedWithoutStart = text.includes(
      '\u9898\u76ee\u96c6\u5df2\u5173\u95ed\uff0c\u65e0\u6cd5\u5f00\u59cb\u7b54\u9898'
    );
    const unanswered = text.includes('\u672a\u7b54\u9898');
    const hasSubmission = Boolean(total) || (!unanswered && (
      text.includes('\u4f5c\u7b54\u65f6\u957f') ||
      text.includes('\u63d0\u4ea4\u5217\u8868') ||
      text.includes('\u5f97\u5206\u8be6\u60c5')
    ));
    const explicitlyUnpublished = /(?:\u6210\u7ee9|\u5206\u6570).{0,8}(?:\u672a\u516c\u5e03|\u6682\u672a\u516c\u5e03|\u4e0d\u516c\u5e03|\u672a\u516c\u5f00)/
      .test(text);
    const record = {
      href: base.href,
      text: base.text,
      sourceUrl: location.href,
      ...(startMatch ? { startedAt: shanghaiIso(startMatch) } : {})
    };
    if (closedWithoutStart || (unanswered && (score === null || score === 0)) ||
        (score === 0 && !hasSubmission)) {
      record.gradeStatus = 'missed';
      record.score = 0;
      if (maxScore !== null && maxScore > 0) record.maxScore = maxScore;
      return record;
    }
    if (!explicitlyUnpublished && score !== null && maxScore !== null &&
        maxScore > 0 && score >= 0 && score <= maxScore && hasSubmission) {
      record.gradeStatus = 'published';
      record.score = score;
      record.maxScore = maxScore;
      if (rankMatch) record.rank = `${rankMatch[1]}/${rankMatch[2]}`;
      return record;
    }
    record.gradeStatus = 'unpublished';
    return record;
  };
  const collectDetail = () => {
    let attempts = 0;
    const poll = () => {
      if (pageHasSessionError()) return fail('pintia-session-corrupt');
      const state = readState();
      if (!state || state.phase !== 'detail') return fail();
      if (pageHasRateLimit()) return finish(state);
      const base = state.queue?.[state.detailIndex];
      if (!base) return finish(state);
      const expected = detailHref(base.href);
      if (!expected) return fail();
      if (location.href !== expected) {
        location.replace(expected);
        return;
      }
      const text = normalize(document.body?.innerText);
      const ready = text.includes('\u7b54\u9898\u4fe1\u606f') ||
        text.includes('\u9898\u76ee\u96c6\u5df2\u5173\u95ed') ||
        text.includes('\u5f97\u5206\u8be6\u60c5') ||
        text.includes('\u672a\u7b54\u9898');
      attempts += 1;
      if (!ready && attempts < 60) {
        setTimeout(poll, 300);
        return;
      }
      const record = ready ? gradeFromPage(base) : {
        href: base.href,
        text: base.text,
        sourceUrl: location.href,
        gradeStatus: 'unpublished'
      };
      if (
        SCAN_SINCE_DATE &&
        record.startedAt &&
        Date.parse(record.startedAt) < Date.parse(`${SCAN_SINCE_DATE}T00:00:00+08:00`)
      ) {
        return finish(state);
      }
      state.gradeCards.push(record);
      state.detailIndex += 1;
      try {
        if (state.candidateCount > 0) {
          localStorage.setItem(
            CURSOR_KEY,
            String((state.cursorStart + state.detailIndex) % state.candidateCount)
          );
        }
      } catch (_) {
        // A blocked cursor write must not discard already collected grades.
      }
      if (!writeState(state)) return fail();
      if (state.detailIndex >= state.queue.length) return finish(state);
      setTimeout(
        () => location.replace(detailHref(state.queue[state.detailIndex].href)),
        DETAIL_DELAY_MS
      );
    };
    poll();
  };

  const startRequested = location.pathname === ACTIVE_PATH && (
    queryMode === 'grades-v2' ||
    queryMode === 'tasks-v1' ||
    (Boolean(storedMode) && !readState())
  );
  if (startRequested) {
    try { sessionStorage.removeItem(STORAGE_KEY); } catch (_) {}
    const state = {
      version: 1,
      phase: 'active',
      activeCards: [],
      allCards: [],
      gradeCards: [],
      queue: [],
      detailIndex: 0,
      listPages: 0
    };
    if (!writeState(state)) return fail();
  } else if (!readState()) {
    return;
  }

  const run = () => {
    const state = readState();
    if (!state) return;
    if (state.phase === 'active') return collectList('active');
    if (state.phase === 'all') return collectList('all');
    if (state.phase === 'detail') return collectDetail();
    fail();
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    run();
  }
})();
"#;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PintiaGradeStatus {
    Published,
    Unpublished,
    Missed,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PintiaCard {
    href: String,
    text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    score: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    max_score: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    rank: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    grade_status: Option<PintiaGradeStatus>,
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
    match url.host_str() {
        Some("pintia.cn") | Some("passport.pintia.cn") => true,
        Some("www.google.com") | Some("www.recaptcha.net") => url.path().starts_with("/recaptcha/"),
        _ => false,
    }
}

fn is_bridge_signal(url: &Url, host: &str) -> bool {
    url.scheme() == "fuckddl-sync" && url.host_str() == Some(host)
}

fn profile_directory(local_data_dir: &Path) -> PathBuf {
    local_data_dir.join("source-profiles").join("pta")
}

fn pintia_profile_directory(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|directory| profile_directory(&directory))
        .map_err(|error| format!("pintia-profile-path-failed:{error}"))
}

fn is_login_page(url: &Url) -> bool {
    match url.host_str() {
        Some("pintia.cn") => url.path().starts_with("/auth/login"),
        Some("passport.pintia.cn") => true,
        _ => false,
    }
}

fn problem_set_id(value: &str, detail: bool) -> Option<String> {
    let url = Url::parse(value).ok()?;
    if url.scheme() != "https"
        || url.host_str() != Some("pintia.cn")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let segments: Vec<_> = url.path_segments()?.collect();
    let expected_tail: &[&str] = if detail {
        &["exam", "overview"]
    } else {
        &["overview"]
    };
    if segments.len() != expected_tail.len() + 2
        || segments.first() != Some(&"problem-sets")
        || segments[2..] != *expected_tail
    {
        return None;
    }
    let id = segments[1];
    (!id.is_empty() && id.bytes().all(|byte| byte.is_ascii_digit())).then(|| id.to_string())
}

fn valid_rank(value: &str) -> bool {
    if value.len() > 32 {
        return false;
    }
    let mut parts = value.split('/');
    let Some(position) = parts.next().and_then(|part| part.parse::<u32>().ok()) else {
        return false;
    };
    let Some(total) = parts.next().and_then(|part| part.parse::<u32>().ok()) else {
        return false;
    };
    parts.next().is_none() && position > 0 && position <= total
}

fn valid_score(value: f64) -> bool {
    value.is_finite() && (0.0..=1_000_000.0).contains(&value)
}

fn valid_card(card: &PintiaCard) -> bool {
    if card.href.len() > 512 || card.text.len() > 8 * 1024 {
        return false;
    }
    let Some(card_id) = problem_set_id(&card.href, false) else {
        return false;
    };
    let detail_id = card
        .source_url
        .as_deref()
        .and_then(|source_url| (source_url.len() <= 512).then_some(source_url))
        .and_then(|source_url| problem_set_id(source_url, true));
    if card.source_url.is_some() && detail_id.as_deref() != Some(card_id.as_str()) {
        return false;
    }
    if card.rank.as_deref().is_some_and(|rank| !valid_rank(rank)) {
        return false;
    }
    if card
        .started_at
        .as_deref()
        .is_some_and(|value| value.len() > 64 || !value.contains('T'))
    {
        return false;
    }

    match card.grade_status {
        None => {
            card.source_url.is_none()
                && card.score.is_none()
                && card.max_score.is_none()
                && card.rank.is_none()
        }
        Some(PintiaGradeStatus::Published) => {
            let (Some(score), Some(max_score)) = (card.score, card.max_score) else {
                return false;
            };
            detail_id.is_some()
                && valid_score(score)
                && valid_score(max_score)
                && max_score > 0.0
                && score <= max_score
        }
        Some(PintiaGradeStatus::Unpublished) => {
            detail_id.is_some()
                && card.score.is_none()
                && card.max_score.is_none()
                && card.rank.is_none()
        }
        Some(PintiaGradeStatus::Missed) => {
            let valid_missed_score = match card.score {
                Some(score) => score == 0.0,
                None => true,
            };
            let valid_missed_max = match card.max_score {
                Some(max_score) => valid_score(max_score) && max_score > 0.0,
                None => true,
            };
            detail_id.is_some() && valid_missed_score && valid_missed_max && card.rank.is_none()
        }
    }
}

fn decode_report(url: &Url) -> Option<Vec<PintiaCard>> {
    if url.scheme() != "fuckddl-sync" || url.host_str() != Some("pintia") {
        return None;
    }
    let payload = url
        .query_pairs()
        .find_map(|(key, value)| (key == "payload").then(|| value.into_owned()))?;
    if payload.len() > MAX_PAYLOAD_BYTES {
        return None;
    }
    let cards: Vec<PintiaCard> = serde_json::from_str(&payload).ok()?;
    if cards.len() > MAX_RETURNED_CARDS || cards.iter().any(|card| !valid_card(card)) {
        return None;
    }
    Some(cards)
}

fn create_window(app: &AppHandle, initial_url: &str, visible: bool) -> Result<(), String> {
    let app_for_navigation = app.clone();
    let app_for_page_load = app.clone();
    let url = initial_url
        .parse()
        .map_err(|_| "pintia-url-invalid".to_string())?;
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "pintia-main-window-missing".to_string())?;
    let builder = WebviewWindowBuilder::new(app, PINTIA_WINDOW_LABEL, WebviewUrl::External(url))
        .title("Fuck DDL · PTA")
        .inner_size(1100.0, 760.0)
        .center()
        .visible(visible)
        .focused(visible)
        .data_directory(pintia_profile_directory(app)?)
        .initialization_script(EXTRACT_SCRIPT)
        .on_page_load(move |_window, payload| {
            if matches!(payload.event(), PageLoadEvent::Started) && is_login_page(payload.url()) {
                let _ = app_for_page_load.emit_to("main", "fuck-ddl:pintia-login-required", ());
            }
        })
        .on_navigation(move |url| {
            if let Some(cards) = decode_report(url) {
                let _ = app_for_navigation.emit_to("main", "fuck-ddl:pintia-sync", cards);
                if let Some(window) = app_for_navigation.get_webview_window(PINTIA_WINDOW_LABEL) {
                    let _ = window.hide();
                }
                return false;
            }
            if is_bridge_signal(url, "pintia-extract-failed") {
                let _ = app_for_navigation.emit_to("main", "fuck-ddl:pintia-extract-failed", ());
                if let Some(window) = app_for_navigation.get_webview_window(PINTIA_WINDOW_LABEL) {
                    let _ = window.hide();
                }
                return false;
            }
            if is_bridge_signal(url, "pintia-session-corrupt") {
                let _ = app_for_navigation.emit_to("main", "fuck-ddl:pintia-session-corrupt", ());
                if let Some(window) = app_for_navigation.get_webview_window(PINTIA_WINDOW_LABEL) {
                    let _ = window.hide();
                }
                return false;
            }
            allowed_navigation(url)
        });
    builder
        .parent(&main)
        .map_err(|error| format!("pintia-window-parent-failed:{error}"))?
        .build()
        .map_err(|error| format!("pintia-window-create-failed:{error}"))?;
    Ok(())
}

#[tauri::command]
pub async fn open_pintia_login(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(PINTIA_WINDOW_LABEL) {
        window
            .show()
            .and_then(|_| window.set_focus())
            .map_err(|error| format!("pintia-window-show-failed:{error}"))?;
        return Ok(());
    }
    create_window(&app, PINTIA_ACTIVE_URL, true)
}

#[tauri::command]
pub async fn reset_pintia_session(app: AppHandle) -> Result<(), String> {
    if app.get_webview_window(PINTIA_WINDOW_LABEL).is_none() {
        create_window(&app, PINTIA_LOGIN_URL, true)?;
        return Ok(());
    }
    let window = app
        .get_webview_window(PINTIA_WINDOW_LABEL)
        .ok_or_else(|| "pintia-window-missing".to_string())?;

    window
        .eval(CLEAR_PINTIA_STORAGE_SCRIPT)
        .map_err(|error| format!("pintia-storage-clear-failed:{error}"))?;
    for cookie_url in ["https://pintia.cn", "https://passport.pintia.cn"] {
        let parsed_url = cookie_url
            .parse()
            .map_err(|_| "pintia-cookie-url-invalid".to_string())?;
        let cookies = window
            .cookies_for_url(parsed_url)
            .map_err(|error| format!("pintia-cookie-read-failed:{error}"))?;
        for cookie in cookies {
            window
                .delete_cookie(cookie)
                .map_err(|error| format!("pintia-cookie-delete-failed:{error}"))?;
        }
    }
    window
        .navigate(
            PINTIA_LOGIN_URL
                .parse()
                .map_err(|_| "pintia-url-invalid".to_string())?,
        )
        .and_then(|_| window.show())
        .and_then(|_| window.set_focus())
        .map_err(|error| format!("pintia-session-reset-failed:{error}"))?;
    Ok(())
}

#[tauri::command]
pub async fn sync_pintia(app: AppHandle, options: Option<PintiaSyncOptions>) -> Result<(), String> {
    let sync_url = pintia_sync_url(options)?;
    if let Some(window) = app.get_webview_window(PINTIA_WINDOW_LABEL) {
        // Clear any leftover scan state from a previous interrupted run.
        let _ = window.eval(
            "try { sessionStorage.removeItem('__fuckddl_pintia_grade_scan_v1__'); \
             sessionStorage.removeItem('__fuckddl_pintia_sync_mode_v1__'); } catch (_) {}",
        );
        window
            .navigate(
                sync_url
                    .parse()
                    .map_err(|_| "pintia-url-invalid".to_string())?,
            )
            .map_err(|error| format!("pintia-navigation-failed:{error}"))?;
        return Ok(());
    }
    create_window(&app, &sync_url, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report_url(payload: serde_json::Value) -> Url {
        Url::parse_with_params("fuckddl-sync://pintia", &[("payload", payload.to_string())])
            .unwrap()
    }

    #[test]
    fn navigation_is_limited_to_login_dependencies() {
        assert!(allowed_navigation(
            &"https://pintia.cn/auth/login".parse().unwrap()
        ));
        assert!(allowed_navigation(
            &"https://passport.pintia.cn/api/u/current".parse().unwrap()
        ));
        assert!(allowed_navigation(&"about:blank".parse().unwrap()));
        assert!(!allowed_navigation(&"about:config".parse().unwrap()));
        assert!(allowed_navigation(
            &"https://www.google.com/recaptcha/api2/anchor"
                .parse()
                .unwrap()
        ));
        assert!(!allowed_navigation(
            &"https://www.google.com/search?q=pintia".parse().unwrap()
        ));
        assert!(!allowed_navigation(&"https://example.com".parse().unwrap()));
        assert!(!allowed_navigation(
            &"file:///C:/secret.txt".parse().unwrap()
        ));
    }

    #[test]
    fn bridge_signals_are_not_treated_as_web_navigation() {
        let failed = "fuckddl-sync://pintia-extract-failed".parse().unwrap();
        assert!(is_bridge_signal(&failed, "pintia-extract-failed"));
        assert!(!allowed_navigation(&failed));
        let corrupt = "fuckddl-sync://pintia-session-corrupt".parse().unwrap();
        assert!(is_bridge_signal(&corrupt, "pintia-session-corrupt"));
        assert!(!allowed_navigation(&corrupt));
    }

    #[test]
    fn grade_scan_is_batched_paced_and_resumable() {
        assert!(EXTRACT_SCRIPT.contains("MAX_DETAIL_ITEMS_PER_SYNC = 8"));
        assert!(EXTRACT_SCRIPT.contains("DETAIL_DELAY_MS = 1600"));
        assert!(EXTRACT_SCRIPT.contains("LIST_PAGE_DELAY_MS = 900"));
        assert!(EXTRACT_SCRIPT.contains("CURSOR_KEY"));
        assert!(EXTRACT_SCRIPT.contains("pageHasRateLimit"));
        assert!(EXTRACT_SCRIPT.contains("KNOWN_FINAL_IDS"));
        assert!(EXTRACT_SCRIPT.contains("SCAN_SINCE_DATE"));
        assert!(EXTRACT_SCRIPT.contains("tasks-v1"));
        assert!(EXTRACT_SCRIPT.contains("SYNC_MODE === 'tasks'"));
        assert!(EXTRACT_SCRIPT.contains("reportCards"));
    }

    #[test]
    fn task_and_grade_urls_use_separate_modes() {
        let tasks = Url::parse(
            &pintia_sync_url(Some(PintiaSyncOptions {
                mode: Some("tasks".to_string()),
                since_date: Some("2026-02-01".to_string()),
                max_items: Some(50),
                known_final_ids: vec!["123".to_string()],
            }))
            .unwrap(),
        )
        .unwrap();
        let task_query = tasks
            .query_pairs()
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(
            task_query.get("fuckddl-sync").map(|value| value.as_ref()),
            Some("tasks-v1")
        );
        assert!(!task_query.contains_key("maxItems"));

        let grades = Url::parse(
            &pintia_sync_url(Some(PintiaSyncOptions {
                mode: Some("grades".to_string()),
                since_date: Some("2026-02-01".to_string()),
                max_items: Some(999),
                known_final_ids: vec!["123".to_string(), "bad-id".to_string()],
            }))
            .unwrap(),
        )
        .unwrap();
        let grade_query = grades
            .query_pairs()
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(
            grade_query.get("fuckddl-sync").map(|value| value.as_ref()),
            Some("grades-v2")
        );
        assert_eq!(
            grade_query.get("maxItems").map(|value| value.as_ref()),
            Some("100")
        );
        assert_eq!(
            grade_query.get("knownFinalIds").map(|value| value.as_ref()),
            Some("123")
        );
    }

    #[test]
    fn pta_profile_path_is_stable_and_source_specific() {
        assert_eq!(
            profile_directory(Path::new("C:/app-data")),
            Path::new("C:/app-data/source-profiles/pta")
        );
    }

    #[test]
    fn login_pages_are_detected_without_blocking_navigation() {
        let login = "https://pintia.cn/auth/login?redirect=/problem-sets/active"
            .parse()
            .unwrap();
        assert!(is_login_page(&login));
        assert!(allowed_navigation(&login));

        let active = PINTIA_ACTIVE_URL.parse().unwrap();
        assert!(!is_login_page(&active));
    }

    #[test]
    fn report_accepts_only_bounded_pintia_cards() {
        let payload = serde_json::json!([{
            "href": "https://pintia.cn/problem-sets/123/overview",
            "text": "虚构作业 关闭时间: 2026-07-20 23:59"
        }]);
        let url = report_url(payload);
        assert_eq!(decode_report(&url).unwrap().len(), 1);

        let foreign = serde_json::json!([{
            "href": "https://example.com/problem-sets/123/overview",
            "text": "伪造任务"
        }]);
        let url = report_url(foreign);
        assert!(decode_report(&url).is_none());
    }

    #[test]
    fn report_preserves_published_40_of_40_with_rank() {
        let url = report_url(serde_json::json!([{
            "href": "https://pintia.cn/problem-sets/2030925912772153344/overview",
            "text": "ZJUFDS-2026-Mon-Bonus 已结束",
            "sourceUrl": "https://pintia.cn/problem-sets/2030925912772153344/exam/overview",
            "score": 40,
            "maxScore": 40,
            "rank": "1/115",
            "gradeStatus": "published"
        }]));
        let cards = decode_report(&url).unwrap();
        assert_eq!(cards[0].score, Some(40.0));
        assert_eq!(cards[0].max_score, Some(40.0));
        assert_eq!(cards[0].rank.as_deref(), Some("1/115"));
        assert_eq!(cards[0].grade_status, Some(PintiaGradeStatus::Published));
    }

    #[test]
    fn report_preserves_published_73_of_100_with_rank() {
        let url = report_url(serde_json::json!([{
            "href": "https://pintia.cn/problem-sets/2063823114061963264/overview",
            "text": "数据结构基础课程期末考试试卷 已结束",
            "sourceUrl": "https://pintia.cn/problem-sets/2063823114061963264/exam/overview",
            "score": 73,
            "maxScore": 100,
            "rank": "505/935",
            "gradeStatus": "published"
        }]));
        let cards = decode_report(&url).unwrap();
        assert_eq!(cards[0].score, Some(73.0));
        assert_eq!(cards[0].max_score, Some(100.0));
        assert_eq!(cards[0].rank.as_deref(), Some("505/935"));
        assert_eq!(cards[0].grade_status, Some(PintiaGradeStatus::Published));
    }

    #[test]
    fn report_distinguishes_missed_from_unpublished_and_submitted_zero() {
        let url = report_url(serde_json::json!([
            {
                "href": "https://pintia.cn/problem-sets/2067965583855030272/overview",
                "text": "Code of Academic Honesty 未答题 已关闭",
                "sourceUrl": "https://pintia.cn/problem-sets/2067965583855030272/exam/overview",
                "score": 0,
                "gradeStatus": "missed"
            },
            {
                "href": "https://pintia.cn/problem-sets/2067965583855030273/overview",
                "text": "成绩暂未公布",
                "sourceUrl": "https://pintia.cn/problem-sets/2067965583855030273/exam/overview",
                "gradeStatus": "unpublished"
            },
            {
                "href": "https://pintia.cn/problem-sets/2067965583855030274/overview",
                "text": "有提交但得分为零",
                "sourceUrl": "https://pintia.cn/problem-sets/2067965583855030274/exam/overview",
                "score": 0,
                "maxScore": 100,
                "gradeStatus": "published"
            }
        ]));
        let cards = decode_report(&url).unwrap();
        assert_eq!(cards[0].grade_status, Some(PintiaGradeStatus::Missed));
        assert_eq!(cards[0].score, Some(0.0));
        assert_eq!(cards[1].grade_status, Some(PintiaGradeStatus::Unpublished));
        assert_eq!(cards[1].score, None);
        assert_eq!(cards[2].grade_status, Some(PintiaGradeStatus::Published));
        assert_eq!(cards[2].score, Some(0.0));
    }

    #[test]
    fn report_rejects_inconsistent_or_unbounded_grade_fields() {
        let score_above_max = report_url(serde_json::json!([{
            "href": "https://pintia.cn/problem-sets/123/overview",
            "text": "invalid",
            "sourceUrl": "https://pintia.cn/problem-sets/123/exam/overview",
            "score": 101,
            "maxScore": 100,
            "gradeStatus": "published"
        }]));
        assert!(decode_report(&score_above_max).is_none());

        let wrong_detail_id = report_url(serde_json::json!([{
            "href": "https://pintia.cn/problem-sets/123/overview",
            "text": "invalid",
            "sourceUrl": "https://pintia.cn/problem-sets/456/exam/overview",
            "score": 10,
            "maxScore": 10,
            "rank": "1/1",
            "gradeStatus": "published"
        }]));
        assert!(decode_report(&wrong_detail_id).is_none());

        let score_without_status = report_url(serde_json::json!([{
            "href": "https://pintia.cn/problem-sets/123/overview",
            "text": "invalid",
            "score": 10,
            "maxScore": 10
        }]));
        assert!(decode_report(&score_without_status).is_none());
    }
}
