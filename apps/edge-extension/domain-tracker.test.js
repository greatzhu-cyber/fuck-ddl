import { describe, expect, it } from "vitest";
import {
  createDomainTracker,
  dispatchTrackerEvents,
  DISTRACTION_THRESHOLD_MS,
  domainFromUrl,
  domainFromWindow,
} from "./domain-tracker.js";

describe("privacy-preserving domain tracker", () => {
  it("keeps only the normalized hostname", () => {
    expect(
      domainFromUrl("https://www.example.com/private?q=secret#answer"),
    ).toBe("example.com");
    expect(domainFromUrl("edge://settings/privacy")).toBeNull();
    expect(domainFromUrl("not a url")).toBeNull();
    expect(domainFromUrl("https://www.example.com./private")).toBe(
      "example.com",
    );
  });

  it("observes a domain only while an Edge window is foreground", () => {
    const tabs = [
      { active: false, url: "https://background.example.com/private" },
      { active: true, url: "https://www.active.example.com/private" },
    ];
    expect(domainFromWindow({ focused: true, tabs })).toBe(
      "active.example.com",
    );
    expect(domainFromWindow({ focused: false, tabs })).toBeNull();
    expect(domainFromWindow({ focused: true, tabs: [] })).toBeNull();
  });

  it("emits once after ten continuous minutes", () => {
    const tracker = createDomainTracker();
    tracker.observe("video.example.com", 1_000);
    expect(tracker.tick(1_000 + DISTRACTION_THRESHOLD_MS - 1)).toEqual([]);
    expect(tracker.tick(1_000 + DISTRACTION_THRESHOLD_MS)).toEqual([
      {
        type: "domain-threshold",
        domain: "video.example.com",
        observedAt: 1_000 + DISTRACTION_THRESHOLD_MS,
      },
    ]);
    expect(tracker.tick(1_000 + DISTRACTION_THRESHOLD_MS * 2)).toEqual([]);
  });

  it("emits a leave event only for a thresholded domain", () => {
    const tracker = createDomainTracker();
    tracker.observe("video.example.com", 0);
    tracker.tick(DISTRACTION_THRESHOLD_MS);
    expect(
      tracker.observe("docs.example.com", DISTRACTION_THRESHOLD_MS + 1),
    ).toEqual([
      {
        type: "domain-left",
        domain: "video.example.com",
        observedAt: DISTRACTION_THRESHOLD_MS + 1,
      },
    ]);
  });

  it("resets continuous time when Edge loses foreground focus", () => {
    const tracker = createDomainTracker();
    const startedAt = 1_000;
    const blurredAt = startedAt + DISTRACTION_THRESHOLD_MS - 1;
    const refocusedAt = blurredAt + 2_000;
    tracker.observe("video.example.com", startedAt);
    expect(tracker.observe(null, blurredAt)).toEqual([]);
    tracker.observe("video.example.com", refocusedAt);
    expect(tracker.tick(refocusedAt + DISTRACTION_THRESHOLD_MS - 1)).toEqual(
      [],
    );
    expect(tracker.tick(refocusedAt + DISTRACTION_THRESHOLD_MS)).toEqual([
      {
        type: "domain-threshold",
        domain: "video.example.com",
        observedAt: refocusedAt + DISTRACTION_THRESHOLD_MS,
      },
    ]);
  });

  it("retries a threshold after native delivery fails", async () => {
    const tracker = createDomainTracker();
    tracker.observe("video.example.com", 0);
    const first = tracker.tick(DISTRACTION_THRESHOLD_MS);
    expect(
      await dispatchTrackerEvents(tracker, first, async () => ({
        ok: false,
        error: "desktop-unavailable",
      })),
    ).toBe(true);
    expect(tracker.snapshot().thresholdSent).toBe(false);

    const retry = tracker.tick(DISTRACTION_THRESHOLD_MS + 1);
    expect(retry).toEqual([
      {
        type: "domain-threshold",
        domain: "video.example.com",
        observedAt: DISTRACTION_THRESHOLD_MS + 1,
      },
    ]);
    expect(
      await dispatchTrackerEvents(tracker, retry, async () => ({ ok: true })),
    ).toBe(false);
    expect(tracker.snapshot().thresholdSent).toBe(true);
  });

  it("restores its minimal state after a service-worker restart", () => {
    const tracker = createDomainTracker({
      domain: "video.example.com",
      startedAt: 10,
      thresholdSent: false,
    });
    expect(tracker.tick(10 + DISTRACTION_THRESHOLD_MS)[0].domain).toBe(
      "video.example.com",
    );
  });
});
