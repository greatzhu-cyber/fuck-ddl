import { describe, expect, it } from "vitest";
import { shouldSendAttentionNotification } from "./desktop-notifications.js";

describe("desktop notification attention policy", () => {
  it("notifies when the desktop window is minimized", () => {
    expect(
      shouldSendAttentionNotification({ hidden: true, focused: false }),
    ).toBe(true);
  });

  it("notifies when Edge is foreground and the desktop window loses focus", () => {
    expect(
      shouldSendAttentionNotification({ hidden: false, focused: false }),
    ).toBe(true);
  });

  it("avoids a duplicate system popup while the desktop window is active", () => {
    expect(
      shouldSendAttentionNotification({ hidden: false, focused: true }),
    ).toBe(false);
  });
});
