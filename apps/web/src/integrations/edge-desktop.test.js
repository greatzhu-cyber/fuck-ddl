import { afterEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));

import { setEdgeFocusActive } from "./edge-desktop.js";

afterEach(() => {
  delete window.__TAURI_INTERNALS__;
  vi.clearAllMocks();
});

describe("Edge 专注状态桥", () => {
  it("网页端不尝试控制本机桥", async () => {
    await expect(setEdgeFocusActive(true)).resolves.toBe(false);
    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  it("桌面端只发送布尔专注状态", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    tauri.invoke.mockResolvedValue(undefined);
    await expect(setEdgeFocusActive(true)).resolves.toBe(true);
    expect(tauri.invoke).toHaveBeenCalledWith("set_edge_focus_active", {
      active: true,
    });
  });
});
