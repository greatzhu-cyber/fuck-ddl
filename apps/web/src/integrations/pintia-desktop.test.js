import { afterEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  listeners: new Map(),
  unlisten: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));

import {
  createPintiaDesktopAdapter,
  isTauriDesktop,
  openPintiaLogin,
  resetPintiaSession,
} from "./pintia-desktop.js";

function enableDesktop() {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {},
  });
}

function prepareListeners() {
  tauri.listen.mockImplementation(async (eventName, handler) => {
    tauri.listeners.set(eventName, handler);
    return tauri.unlisten;
  });
}

afterEach(() => {
  delete window.__TAURI_INTERNALS__;
  tauri.listeners.clear();
  vi.clearAllMocks();
});

describe("PTA 桌面桥", () => {
  it("does not expose source login in the regular web build", () => {
    expect(isTauriDesktop()).toBe(false);
  });

  it("opens the bounded desktop login window", async () => {
    enableDesktop();
    tauri.invoke.mockResolvedValue(undefined);
    await openPintiaLogin();
    expect(tauri.invoke).toHaveBeenCalledWith("open_pintia_login");
  });

  it("resets only the PTA source session on request", async () => {
    enableDesktop();
    tauri.invoke.mockResolvedValue(undefined);
    await resetPintiaSession();
    expect(tauri.invoke).toHaveBeenCalledWith("reset_pintia_session");
  });

  it("accepts an explicit empty active-set snapshot", async () => {
    enableDesktop();
    prepareListeners();
    tauri.invoke.mockImplementation(async (command, payload) => {
      expect(command).toBe("sync_pintia");
      expect(payload).toEqual({ options: { mode: "tasks" } });
      tauri.listeners.get("fuck-ddl:pintia-sync")({ payload: [] });
    });

    await expect(createPintiaDesktopAdapter().sync()).resolves.toMatchObject({
      updates: [],
      completions: [],
      expirations: [],
      grades: [],
      debug: expect.objectContaining({ source: "PTA", mode: "tasks" }),
    });
    expect(tauri.unlisten).toHaveBeenCalledTimes(4);
  });

  it("passes grades mode and grade-only snapshot options to the desktop host", async () => {
    enableDesktop();
    prepareListeners();
    tauri.invoke.mockImplementation(async (command, payload) => {
      expect(command).toBe("sync_pintia");
      expect(payload).toEqual({
        options: {
          sinceDate: "2026-02-01",
          maxItems: 50,
          knownFinalIds: ["9"],
          mode: "grades",
        },
      });
      tauri.listeners.get("fuck-ddl:pintia-sync")({
        payload: [
          {
            href: "https://pintia.cn/problem-sets/9/overview",
            text: "Bonus 关闭时间: 2026-01-01 23:59 已关闭",
            sourceUrl: "https://pintia.cn/problem-sets/9/exam/overview",
            gradeStatus: "published",
            score: 10,
            maxScore: 10,
            rank: "1/2",
          },
        ],
      });
    });

    await expect(
      createPintiaDesktopAdapter(() => ({
        sinceDate: "2026-02-01",
        maxItems: 50,
        knownFinalIds: ["9"],
      })).sync({ mode: "grades" }),
    ).resolves.toMatchObject({
      updates: [],
      completions: [],
      expirations: [],
      grades: [expect.objectContaining({ sourceId: "9", score: 10 })],
    });
  });

  it("reports an expired login immediately and cleans every listener", async () => {
    enableDesktop();
    prepareListeners();
    tauri.invoke.mockImplementation(async () => {
      tauri.listeners.get("fuck-ddl:pintia-login-required")({ payload: null });
    });

    await expect(createPintiaDesktopAdapter().sync()).rejects.toThrow(
      "pintia-login-required",
    );
    expect(tauri.unlisten).toHaveBeenCalledTimes(4);
  });

  it("keeps data when the page cannot be parsed", async () => {
    enableDesktop();
    prepareListeners();
    tauri.invoke.mockImplementation(async () => {
      tauri.listeners.get("fuck-ddl:pintia-extract-failed")({ payload: null });
    });

    await expect(createPintiaDesktopAdapter().sync()).rejects.toThrow(
      "pintia-extract-failed",
    );
  });

  it("distinguishes a corrupt PTA session from a parser failure", async () => {
    enableDesktop();
    prepareListeners();
    tauri.invoke.mockImplementation(async () => {
      tauri.listeners.get("fuck-ddl:pintia-session-corrupt")({
        payload: null,
      });
    });

    await expect(createPintiaDesktopAdapter().sync()).rejects.toThrow(
      "pta-session-corrupt",
    );
    expect(tauri.unlisten).toHaveBeenCalledTimes(4);
  });
});
