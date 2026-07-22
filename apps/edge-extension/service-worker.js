import {
  createDomainTracker,
  dispatchTrackerEvents,
  domainFromWindow,
} from "./domain-tracker.js";

const HOST_NAME = "com.fuckddl.edge_host";
const ALARM_NAME = "fuck-ddl-domain-check";
let tracker;
let initializing;

async function initialize() {
  if (tracker) return tracker;
  if (!initializing) {
    initializing = chrome.storage.session
      .get("trackerState")
      .then(({ trackerState }) => {
        tracker = createDomainTracker(trackerState);
        return tracker;
      });
  }
  return initializing;
}

async function saveState() {
  if (!tracker) return;
  await chrome.storage.session.set({ trackerState: tracker.snapshot() });
}

async function sendEvent(event) {
  const response = await new Promise((resolve) => {
    chrome.runtime.sendNativeMessage(HOST_NAME, event, (message) => {
      const error = chrome.runtime.lastError;
      resolve(
        error
          ? { ok: false, error: error.message }
          : (message ?? { ok: false, error: "empty-response" }),
      );
    });
  });
  await chrome.storage.local.set({
    lastBridgeResult: {
      ok: Boolean(response?.ok),
      error: response?.error ?? null,
      at: new Date().toISOString(),
    },
  });
  await chrome.action.setBadgeBackgroundColor({ color: "#b54708" });
  await chrome.action.setBadgeText({ text: response?.ok ? "" : "!" });
  return response;
}

async function dispatch(events) {
  const stateChanged = await dispatchTrackerEvents(tracker, events, sendEvent);
  if (stateChanged) await saveState();
}

async function observedWindow(windowId) {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return null;
  try {
    if (Number.isInteger(windowId)) {
      return await chrome.windows.get(windowId, { populate: true });
    }
    return await chrome.windows.getLastFocused({ populate: true });
  } catch {
    return null;
  }
}

async function observeActiveTab(windowId) {
  const currentTracker = await initialize();
  const browserWindow = await observedWindow(windowId);
  const events = currentTracker.observe(
    domainFromWindow(browserWindow),
    Date.now(),
  );
  await saveState();
  await dispatch(events);
}

async function checkThreshold() {
  const currentTracker = await initialize();
  await observeActiveTab();
  const events = currentTracker.tick(Date.now());
  await saveState();
  await dispatch(events);
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
  void observeActiveTab();
});
chrome.runtime.onStartup.addListener(() => void observeActiveTab());
chrome.tabs.onActivated.addListener(() => void observeActiveTab());
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === "complete")
    void observeActiveTab();
});
chrome.windows.onFocusChanged.addListener(
  (windowId) => void observeActiveTab(windowId),
);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) void checkThreshold();
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "check-bridge") return false;
  void sendEvent({
    type: "bridge-ping",
    domain: "local",
    observedAt: Date.now(),
  }).then(sendResponse);
  return true;
});

void chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
void observeActiveTab();
