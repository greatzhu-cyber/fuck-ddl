import { describe, expect, it, vi } from "vitest";
import {
  connectedSourceCount,
  mergeSourceUpdates,
  registerSourceAdapter,
  SOURCE_SYNC_INTERVAL_MS,
  syncSources,
} from "./source-sync.js";

describe("source sync scheduler contract", () => {
  it("uses the approved forty-five minute interval", () => {
    expect(SOURCE_SYNC_INTERVAL_MS).toBe(45 * 60 * 1000);
  });

  it("reports disconnected without inventing source progress", async () => {
    expect(connectedSourceCount()).toBe(0);
    await expect(syncSources()).resolves.toMatchObject({
      status: "disconnected",
      updates: [],
      completions: [],
      expirations: [],
      grades: [],
    });
  });

  it("syncs a registered source and only merges locked fields", async () => {
    const sync = vi.fn().mockResolvedValue([{ id: "one", progress: 80 }]);
    const unregister = registerSourceAdapter("PTA", { sync });
    try {
      const result = await syncSources({
        task: { id: "one", source: "PTA" },
      });
      expect(sync).toHaveBeenCalledOnce();
      expect(
        mergeSourceUpdates(
          [
            { id: "one", progress: 20, sourceLocked: true },
            { id: "two", progress: 20, sourceLocked: false },
          ],
          [...result.updates, { id: "two", progress: 90 }],
          result,
        ),
      ).toEqual([
        { id: "one", progress: 80, sourceLocked: true },
        { id: "two", progress: 20, sourceLocked: false },
      ]);
    } finally {
      unregister();
    }
  });

  it("adds a complete imported task once and keeps it source locked", () => {
    const imported = {
      id: "pintia:123",
      title: "算法练习",
      source: "PTA",
      deadlineAt: "2026-07-20T15:59:00.000Z",
      progress: 25,
      sourceLocked: true,
    };
    const first = mergeSourceUpdates([], [imported]);
    expect(first).toEqual([imported]);
    expect(mergeSourceUpdates(first, [imported])).toHaveLength(1);
  });

  it("replaces categorical source progress metadata on refresh", () => {
    const current = {
      id: "zju:99089:lab0",
      title: "Lab0",
      source: "学在浙大",
      sourceLocked: true,
      progress: 50,
      sourceProgressEstimated: true,
      deadlineAt: "2026-07-21T15:59:00.000Z",
    };
    expect(
      mergeSourceUpdates(
        [current],
        [
          {
            ...current,
            progress: 0,
            sourceProgressEstimated: false,
            sourceUrl: "https://courses.zju.edu.cn/course/99089/content",
          },
        ],
      ),
    ).toEqual([
      expect.objectContaining({
        progress: 0,
        sourceProgressEstimated: false,
        sourceUrl: "https://courses.zju.edu.cn/course/99089/content",
      }),
    ]);
  });

  it("mirrors a successfully synced source and removes stale locked tasks", () => {
    const tasks = [
      {
        id: "pintia:old",
        title: "旧来源任务",
        source: "PTA",
        sourceLocked: true,
        deadlineAt: "2026-06-01T00:00:00.000Z",
        progress: 20,
      },
      {
        id: "manual-note",
        title: "手动记录",
        source: "PTA",
        sourceLocked: false,
        deadlineAt: "2026-07-01T00:00:00.000Z",
        progress: 10,
      },
      {
        id: "zju:one",
        title: "其他来源",
        source: "学在浙大",
        sourceLocked: true,
        deadlineAt: "2026-07-01T00:00:00.000Z",
        progress: 10,
      },
    ];
    expect(
      mergeSourceUpdates(tasks, [], {
        syncedSources: ["PTA"],
        fullSync: true,
      }).map((task) => task.id),
    ).toEqual(["manual-note", "zju:one"]);
  });

  it("removes only the target when a task-specific refresh no longer returns it", () => {
    const tasks = [
      {
        id: "pintia:one",
        title: "任务一",
        source: "PTA",
        sourceLocked: true,
      },
      {
        id: "pintia:two",
        title: "任务二",
        source: "PTA",
        sourceLocked: true,
      },
    ];
    expect(
      mergeSourceUpdates(tasks, [], {
        syncedSources: ["PTA"],
        fullSync: false,
        targetTaskId: "pintia:one",
        targetSource: "PTA",
      }),
    ).toEqual([tasks[1]]);
  });

  it("carries explicit completion metadata through a source snapshot", async () => {
    const completed = {
      id: "zju:done",
      title: "已交作业",
      source: "学在浙大",
      sourceLocked: true,
      sourceStatus: "completed",
      progress: 100,
    };
    const unregister = registerSourceAdapter("学在浙大", {
      sync: vi.fn().mockResolvedValue({
        updates: [],
        completions: [completed],
        expirations: [],
      }),
    });
    try {
      await expect(syncSources()).resolves.toMatchObject({
        status: "success",
        updates: [],
        completions: [completed],
        expirations: [],
      });
    } finally {
      unregister();
    }
  });

  it("carries grade records separately from the active task mirror", async () => {
    const grade = {
      sourceName: "PTA",
      sourceId: "2030925912772153344",
      title: "ZJUFDS-2026-Mon-Bonus",
      score: 40,
      maxScore: 40,
      status: "published",
    };
    const unregister = registerSourceAdapter("PTA", {
      sync: vi.fn().mockResolvedValue({
        updates: [],
        completions: [],
        expirations: [],
        grades: [grade],
      }),
    });
    try {
      await expect(syncSources({ mode: "grades" })).resolves.toMatchObject({
        status: "success",
        grades: [grade],
        fullSync: false,
        syncMode: "grades",
      });
    } finally {
      unregister();
    }
  });

  it("defaults to task mode and never full-mirrors during grade sync", async () => {
    const sync = vi.fn().mockResolvedValue({
      updates: [{ id: "pintia:1", progress: 10 }],
      completions: [],
      expirations: [],
      grades: [],
    });
    const unregister = registerSourceAdapter("PTA", { sync });
    try {
      await expect(syncSources()).resolves.toMatchObject({
        fullSync: true,
        syncMode: "tasks",
      });
      expect(sync).toHaveBeenCalledWith({ mode: "tasks" });

      sync.mockResolvedValueOnce({
        updates: [],
        completions: [],
        expirations: [],
        grades: [{ sourceId: "1", sourceName: "PTA", status: "published" }],
      });
      await expect(syncSources({ mode: "grades" })).resolves.toMatchObject({
        fullSync: false,
        syncMode: "grades",
      });
      expect(sync).toHaveBeenLastCalledWith({ mode: "grades" });
    } finally {
      unregister();
    }
  });

  it("runs adapters one after another instead of in parallel", async () => {
    const order = [];
    const slow = vi.fn().mockImplementation(async () => {
      order.push("a-start");
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push("a-end");
      return { updates: [], completions: [], expirations: [], grades: [] };
    });
    const fast = vi.fn().mockImplementation(async () => {
      order.push("b-start");
      order.push("b-end");
      return { updates: [], completions: [], expirations: [], grades: [] };
    });
    const unregA = registerSourceAdapter("PTA", { sync: slow });
    const unregB = registerSourceAdapter("学在浙大", { sync: fast });
    try {
      await syncSources({ mode: "tasks" });
      expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
    } finally {
      unregA();
      unregB();
    }
  });

  it("propagates a successful empty snapshot through the full sync contract", async () => {
    const unregister = registerSourceAdapter("PTA", {
      sync: vi.fn().mockResolvedValue([]),
    });
    try {
      const result = await syncSources();
      expect(result).toMatchObject({
        status: "success",
        updates: [],
        syncedSources: ["PTA"],
        fullSync: true,
      });
      expect(
        mergeSourceUpdates(
          [
            {
              id: "pintia:stale",
              title: "旧题目集",
              source: "PTA",
              sourceLocked: true,
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

  it("never purges a source whose adapter failed during a partial sync", async () => {
    const unregisterPintia = registerSourceAdapter("PTA", {
      sync: vi.fn().mockResolvedValue([]),
    });
    const unregisterZju = registerSourceAdapter("学在浙大", {
      sync: vi.fn().mockRejectedValue(new Error("offline")),
    });
    try {
      const result = await syncSources();
      expect(result.syncedSources).toEqual(["PTA"]);
      expect(result.errors).toEqual([
        { source: "学在浙大", message: "offline" },
      ]);
      expect(
        mergeSourceUpdates(
          [
            {
              id: "pintia:stale",
              source: "PTA",
              sourceLocked: true,
            },
            {
              id: "zju:keep",
              source: "学在浙大",
              sourceLocked: true,
            },
          ],
          result.updates,
          result,
        ).map((task) => task.id),
      ).toEqual(["zju:keep"]);
    } finally {
      unregisterPintia();
      unregisterZju();
    }
  });
});
