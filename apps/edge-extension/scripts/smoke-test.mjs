import assert from "node:assert/strict";
import {
  createDomainTracker,
  dispatchTrackerEvents,
  DISTRACTION_THRESHOLD_MS,
  domainFromUrl,
  domainFromWindow,
} from "../domain-tracker.js";
import { bridgeStatusView } from "../bridge-status.js";

assert.equal(
  domainFromUrl("https://www.example.com/private?q=secret"),
  "example.com",
);
assert.equal(bridgeStatusView({ ok: true }).tone, "connected");
assert.equal(
  bridgeStatusView({
    ok: false,
    error: "Specified native messaging host not found.",
  }).title,
  "Native Host 未注册",
);
assert.equal(
  bridgeStatusView({ ok: false, error: "Could not establish connection" })
    .title,
  "桌面端尚未运行",
);
assert.equal(domainFromUrl("edge://settings/privacy"), null);
assert.equal(
  domainFromWindow({
    focused: true,
    tabs: [{ active: true, url: "https://www.example.com/private" }],
  }),
  "example.com",
);
assert.equal(
  domainFromWindow({
    focused: false,
    tabs: [{ active: true, url: "https://www.example.com/private" }],
  }),
  null,
);

const tracker = createDomainTracker();
tracker.observe("video.example.com", 0);
assert.deepEqual(tracker.tick(DISTRACTION_THRESHOLD_MS - 1), []);
assert.equal(
  tracker.tick(DISTRACTION_THRESHOLD_MS)[0].type,
  "domain-threshold",
);
assert.equal(
  tracker.observe("docs.example.com", DISTRACTION_THRESHOLD_MS + 1)[0].type,
  "domain-left",
);

const foregroundTracker = createDomainTracker();
foregroundTracker.observe("video.example.com", 0);
foregroundTracker.observe(null, DISTRACTION_THRESHOLD_MS - 1);
const refocusedAt = DISTRACTION_THRESHOLD_MS + 1_000;
foregroundTracker.observe("video.example.com", refocusedAt);
assert.deepEqual(
  foregroundTracker.tick(refocusedAt + DISTRACTION_THRESHOLD_MS - 1),
  [],
);
assert.equal(
  foregroundTracker.tick(refocusedAt + DISTRACTION_THRESHOLD_MS)[0].type,
  "domain-threshold",
);

const retryTracker = createDomainTracker();
retryTracker.observe("video.example.com", 0);
const firstAttempt = retryTracker.tick(DISTRACTION_THRESHOLD_MS);
assert.equal(
  await dispatchTrackerEvents(retryTracker, firstAttempt, async () => ({
    ok: false,
  })),
  true,
);
assert.equal(retryTracker.snapshot().thresholdSent, false);
assert.equal(
  retryTracker.tick(DISTRACTION_THRESHOLD_MS + 1)[0].type,
  "domain-threshold",
);
console.log("Edge domain tracker smoke test passed");
