export const DISTRACTION_THRESHOLD_MS = 10 * 60 * 1000;

export function domainFromUrl(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    return url.hostname
      .toLowerCase()
      .replace(/^www\./, "")
      .replace(/\.$/, "");
  } catch {
    return null;
  }
}

export function domainFromWindow(browserWindow) {
  if (!browserWindow?.focused || !Array.isArray(browserWindow.tabs))
    return null;
  const activeTab = browserWindow.tabs.find((tab) => tab?.active);
  return domainFromUrl(activeTab?.url);
}

export function createDomainTracker(
  initialState = {},
  thresholdMs = DISTRACTION_THRESHOLD_MS,
) {
  let state = {
    domain: initialState.domain ?? null,
    startedAt: Number.isFinite(Number(initialState.startedAt))
      ? Number(initialState.startedAt)
      : null,
    thresholdSent: Boolean(initialState.thresholdSent),
  };

  function observe(domain, now = Date.now()) {
    const normalized = domain?.toLowerCase() ?? null;
    const events = [];
    if (normalized === state.domain) return events;
    if (state.domain && state.thresholdSent) {
      events.push({
        type: "domain-left",
        domain: state.domain,
        observedAt: now,
      });
    }
    state = {
      domain: normalized,
      startedAt: normalized ? now : null,
      thresholdSent: false,
    };
    return events;
  }

  function tick(now = Date.now()) {
    if (
      !state.domain ||
      state.thresholdSent ||
      state.startedAt === null ||
      now - state.startedAt < thresholdMs
    )
      return [];
    state.thresholdSent = true;
    return [
      {
        type: "domain-threshold",
        domain: state.domain,
        observedAt: now,
      },
    ];
  }

  function snapshot() {
    return { ...state };
  }

  function markDeliveryFailed(event) {
    if (
      event?.type !== "domain-threshold" ||
      event.domain !== state.domain ||
      !state.thresholdSent
    )
      return false;
    state.thresholdSent = false;
    return true;
  }

  return { markDeliveryFailed, observe, snapshot, tick };
}

export async function dispatchTrackerEvents(tracker, events, sender) {
  let stateChanged = false;
  for (const event of events) {
    let response;
    try {
      response = await sender(event);
    } catch {
      response = { ok: false };
    }
    if (!response?.ok) {
      stateChanged = tracker.markDeliveryFailed(event) || stateChanged;
    }
  }
  return stateChanged;
}
