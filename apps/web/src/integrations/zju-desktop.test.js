import { afterEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  listeners: new Map(),
  unlisten: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));

import { createZjuDesktopAdapter, openZjuLogin } from "./zju-desktop.js";
import {
  mergeSourceUpdates,
  registerSourceAdapter,
  syncSources,
} from "../source-sync.js";

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

describe("学在浙大桌面桥", () => {
  it("打开受限的桌面登录窗口", async () => {
    enableDesktop();
    tauri.invoke.mockResolvedValue(undefined);
    await openZjuLogin();
    expect(tauri.invoke).toHaveBeenCalledWith("open_zju_login");
  });

  it("把真实页面记录转换为只读任务", async () => {
    enableDesktop();
    prepareListeners();
    tauri.invoke.mockImplementation(async (command, payload) => {
      expect(command).toBe("sync_zju");
      expect(payload).toEqual({ options: { mode: "tasks" } });
      tauri.listeners.get("fuck-ddl:zju-sync")({
        payload: [
          {
            courseId: "99089",
            courseTitle: "信息安全课程综合实践",
            title: "Lab0",
            text: "结束时间: 2099-07-21 23:59 部分完成",
          },
        ],
      });
    });

    await expect(createZjuDesktopAdapter().sync()).resolves.toMatchObject({
      updates: [
        expect.objectContaining({
          title: "Lab0",
          source: "学在浙大",
          sourceLocked: true,
        }),
      ],
      completions: [],
      expirations: [],
      grades: [],
      debug: expect.objectContaining({ source: "学在浙大", mode: "tasks" }),
    });
    expect(tauri.unlisten).toHaveBeenCalledTimes(4);
  });

  it("成绩模式未选课程时跳过爬取", async () => {
    enableDesktop();
    await expect(
      createZjuDesktopAdapter(() => ({ courses: [] })).sync({ mode: "grades" }),
    ).resolves.toMatchObject({
      grades: [],
      debug: expect.objectContaining({
        skipped: expect.stringContaining("no-courses-selected"),
      }),
    });
    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  it("成绩模式只回写成绩账本，并带上选中课程", async () => {
    enableDesktop();
    prepareListeners();
    tauri.invoke.mockImplementation(async (command, payload) => {
      expect(command).toBe("sync_zju");
      expect(payload).toEqual({
        options: {
          mode: "grades",
          courses: [
            {
              courseId: "99089",
              courseTitle: "信息安全课程综合实践",
              courseUrl: "https://courses.zju.edu.cn/course/99089/content",
              semester: "未知学期",
            },
          ],
        },
      });
      tauri.listeners.get("fuck-ddl:zju-sync")({
        payload: [
          {
            courseId: "99089",
            courseTitle: "信息安全课程综合实践",
            activityId: "123",
            activityUrl:
              "https://courses.zju.edu.cn/course/99089/learning-activity/full-screen#/123",
            title: "Lab0",
            text: "结束时间: 2026-07-01 23:59 已交 10 分",
            gradeStatus: "published",
            score: 10,
            maxScore: 10,
          },
        ],
      });
    });

    await expect(
      createZjuDesktopAdapter(() => ({
        courses: [
          {
            courseId: "99089",
            courseTitle: "信息安全课程综合实践",
            courseUrl: "https://courses.zju.edu.cn/course/99089/content",
          },
        ],
      })).sync({ mode: "grades" }),
    ).resolves.toMatchObject({
      updates: [],
      grades: [expect.objectContaining({ sourceId: "123", score: 10 })],
    });
  });

  it("登录失效时立即失败并保留旧数据", async () => {
    enableDesktop();
    prepareListeners();
    tauri.invoke.mockImplementation(async () => {
      tauri.listeners.get("fuck-ddl:zju-login-required")({ payload: null });
    });

    await expect(createZjuDesktopAdapter().sync()).rejects.toThrow(
      "zju-login-required",
    );
  });

  it("接受明确的空课程快照并清理监听器", async () => {
    enableDesktop();
    prepareListeners();
    tauri.invoke.mockImplementation(async () => {
      tauri.listeners.get("fuck-ddl:zju-sync")({ payload: [] });
    });

    await expect(createZjuDesktopAdapter().sync()).resolves.toMatchObject({
      updates: [],
      completions: [],
      expirations: [],
      grades: [],
      debug: expect.objectContaining({ rawCount: 0 }),
    });
    expect(tauri.unlisten).toHaveBeenCalledTimes(4);
  });

  it("全量刷新时把课程摘要的已交状态从本地 DDL 中移除", async () => {
    enableDesktop();
    prepareListeners();
    tauri.invoke.mockImplementation(async () => {
      tauri.listeners.get("fuck-ddl:zju-sync")({
        payload: [
          {
            courseId: "95870",
            courseTitle: "大学物理（乙）I",
            title: "大物乙I 布置的所有习题",
            text: "大物乙I 布置的所有习题 已交 已结束 活动时间 2026-03-21 12:06 - 2026-07-18 12:06",
          },
        ],
      });
    });

    const unregister = registerSourceAdapter(
      "学在浙大",
      createZjuDesktopAdapter(),
    );
    try {
      const result = await syncSources();
      expect(result).toMatchObject({
        status: "success",
        updates: [],
        completions: [
          expect.objectContaining({
            title: "大物乙I 布置的所有习题",
            sourceStatus: "completed",
          }),
        ],
        syncedSources: ["学在浙大"],
        fullSync: true,
      });
      expect(
        mergeSourceUpdates(
          [
            {
              id: "zju:95870:legacy",
              source: "学在浙大",
              sourceLocked: true,
              title: "大物乙I 布置的所有习题",
              deadlineAt: "2026-07-18T04:06:00.000Z",
              progress: 0,
            },
          ],
          result.updates,
          result,
        ),
      ).toEqual([]);
    } finally {
      unregister();
    }
  });

  it("页面解析失败时拒绝同步", async () => {
    enableDesktop();
    prepareListeners();
    tauri.invoke.mockImplementation(async () => {
      tauri.listeners.get("fuck-ddl:zju-extract-failed")({ payload: null });
    });

    await expect(createZjuDesktopAdapter().sync()).rejects.toThrow(
      "zju-extract-failed",
    );
  });
});
