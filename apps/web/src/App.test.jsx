import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "./App.jsx";
import { encodePersistedState, STORAGE_KEYS } from "./persistence.js";
import { createCompletionRecord } from "./completion-history.js";

function seedTasks(tasks) {
  window.localStorage.setItem(STORAGE_KEYS.tasks, encodePersistedState(tasks));
}

function seedCompletionHistory(entries) {
  window.localStorage.setItem(
    STORAGE_KEYS.completionHistory,
    encodePersistedState(entries),
  );
}

function seedGoals(goals) {
  window.localStorage.setItem(STORAGE_KEYS.goals, encodePersistedState(goals));
}

function seedGrades(grades) {
  window.localStorage.setItem(
    STORAGE_KEYS.gradeRecords,
    encodePersistedState(grades),
  );
}

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("Fuck DDL core interactions", () => {
  it("opens the grade ledger from the main navigation", () => {
    seedGrades([
      {
        id: "grade:PTA:bonus",
        sourceName: "PTA",
        sourceId: "bonus",
        courseName: "PTA",
        title: "ZJUFDS-2026-Mon-Bonus",
        status: "published",
        score: 40,
        maxScore: 40,
        rank: 1,
        rankingTotal: 115,
        deadlineAt: "2026-06-20T15:59:00.000Z",
      },
    ]);
    render(<App />);
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "主导航" })).getByRole(
        "button",
        { name: "成绩" },
      ),
    );
    expect(screen.getByRole("main", { name: "成绩" })).toBeTruthy();
    expect(screen.getByText("ZJUFDS-2026-Mon-Bonus")).toBeTruthy();
    expect(screen.getByText("40 / 40 分")).toBeTruthy();
  });

  it("states clearly when GitHub cloud login has not been configured", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "账户菜单" }));
    expect(screen.getByText("GitHub 登录未配置")).toBeTruthy();
    expect(screen.getByText(/本地任务可继续使用/)).toBeTruthy();
  });

  it("captures an inbox item and turns it into a task only after a DDL is supplied", () => {
    render(<App />);
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "主导航" })).getByRole(
        "button",
        { name: "收件箱" },
      ),
    );
    fireEvent.change(screen.getByLabelText("收件箱内容"), {
      target: { value: "整理调研资料" },
    });
    fireEvent.click(screen.getByRole("button", { name: "记录" }));
    expect(screen.getByText("整理调研资料")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "安排 DDL" }));
    fireEvent.change(screen.getByLabelText("DDL"), {
      target: { value: "2030-01-01T20:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加任务" }));
    expect(screen.getByText("收件箱是空的")).toBeTruthy();
  });

  it("creates a project, assigns a manual task, and preserves the task when the project is deleted", () => {
    render(<App />);
    const navigation = screen.getByRole("navigation", { name: "主导航" });
    fireEvent.click(within(navigation).getByRole("button", { name: "项目" }));
    fireEvent.click(screen.getByRole("button", { name: "新建项目" }));
    fireEvent.change(screen.getByLabelText("项目名称"), {
      target: { value: "课程大作业" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建项目" }));

    fireEvent.click(screen.getByRole("button", { name: "快速添加" }));
    fireEvent.change(screen.getByPlaceholderText("例如：完成实验报告"), {
      target: { value: "项目内任务" },
    });
    fireEvent.change(screen.getByLabelText("DDL"), {
      target: { value: "2030-01-01T20:00" },
    });
    const projectSelect = screen.getByLabelText("所属项目");
    fireEvent.change(projectSelect, {
      target: { value: projectSelect.options[1].value },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加任务" }));

    fireEvent.click(within(navigation).getByRole("button", { name: "项目" }));
    expect(screen.getByText(/1 项任务/)).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "编辑项目 课程大作业" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "删除项目" }));
    fireEvent.click(
      within(navigation).getByRole("button", { name: "最近 DDL" }),
    );
    expect(screen.getByText("项目内任务")).toBeTruthy();
  });

  it("adds and removes a manual work-time entry without leaving stale history", () => {
    render(<App />);
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "主导航" })).getByRole(
        "button",
        { name: "统计" },
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "补录时间" }));
    fireEvent.change(screen.getByLabelText("工作时长（分钟）"), {
      target: { value: "45" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存补录" }));
    expect(screen.getByText("手动补录")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "删除补录时间" }));
    expect(screen.queryByText("手动补录")).toBeNull();
  });

  it("shows the nearest deadline first in the default view", () => {
    seedTasks([
      {
        id: "later",
        title: "稍后截止",
        source: "手动",
        progress: 0,
        deadlineAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      },
      {
        id: "nearest",
        title: "最近截止",
        source: "手动",
        progress: 0,
        deadlineAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    ]);
    render(<App />);
    const rows = screen.getAllByRole("row");
    expect(rows[1].textContent).toContain("最近截止");
    expect(screen.getByRole("main", { name: "最近 DDL" })).toBeTruthy();
  });

  it("lets today plan override the automatic order for the current local day", () => {
    seedTasks([
      {
        id: "today-nearest",
        title: "今日先做",
        source: "手动",
        progress: 0,
        deadlineAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
      {
        id: "today-later",
        title: "今日后做",
        source: "手动",
        progress: 0,
        deadlineAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      },
    ]);
    render(<App />);
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "主导航" })).getByRole(
        "button",
        { name: "今日计划" },
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "下移 今日先做" }));
    const rows = within(
      screen.getByRole("table", { name: "今日计划任务" }),
    ).getAllByRole("row");
    expect(rows[1].textContent).toContain("今日后做");
  });

  it("creates a manual task with required title and DDL", () => {
    const view = render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "快速添加" }));

    fireEvent.change(screen.getByPlaceholderText("例如：完成实验报告"), {
      target: { value: "完成组件测试" },
    });
    fireEvent.change(screen.getByLabelText("DDL"), {
      target: { value: "2030-01-01T20:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加任务" }));

    expect(screen.getByText("完成组件测试")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "快速添加任务" })).toBeNull();

    view.unmount();
    render(<App />);
    expect(screen.getByText("完成组件测试")).toBeTruthy();
  });

  it("edits and deletes a manually added task", () => {
    seedTasks([
      {
        id: "manual-edit",
        title: "需要改名的任务",
        source: "手动",
        progress: 20,
        deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
        importance: "medium",
        sourceLocked: false,
      },
    ]);
    render(<App />);
    fireEvent.click(screen.getAllByRole("row")[1]);
    fireEvent.click(screen.getByRole("button", { name: "编辑任务" }));
    fireEvent.change(screen.getByLabelText("任务名称"), {
      target: { value: "已编辑的任务" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存任务" }));
    expect(screen.getAllByText("已编辑的任务").length).toBeGreaterThan(0);

    fireEvent.click(screen.getAllByRole("row")[1]);
    fireEvent.click(screen.getByRole("button", { name: "删除任务" }));
    expect(screen.queryByText("已编辑的任务")).toBeNull();
  });

  it("maintains notes and subtasks inside a manual task", () => {
    seedTasks([
      {
        id: "manual-detail",
        title: "带详情的任务",
        source: "手动",
        progress: 0,
        deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
        importance: "medium",
        sourceLocked: false,
      },
    ]);
    render(<App />);
    fireEvent.click(screen.getAllByRole("row")[1]);
    fireEvent.change(screen.getByLabelText("子任务名称"), {
      target: { value: "先完成提纲" },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加子任务" }));
    expect(screen.getByText("先完成提纲")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox"));

    fireEvent.click(screen.getByRole("button", { name: "编辑任务" }));
    fireEvent.change(screen.getByLabelText("备注（可选）"), {
      target: { value: "资料在课程文件夹" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存任务" }));
    fireEvent.click(screen.getAllByRole("row")[1]);
    expect(screen.getAllByText("资料在课程文件夹").length).toBe(2);
    expect(screen.getByText("先完成提纲")).toBeTruthy();
  });

  it("lets the focus panel choose the task instead of always using a default", () => {
    seedTasks([
      {
        id: "focus-choice",
        title: "我选择的专注任务",
        source: "手动",
        progress: 0,
        deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    ]);
    render(<App />);
    const focusPanel = screen.getByText("当前专注").closest("section");
    fireEvent.change(within(focusPanel).getByLabelText("专注任务"), {
      target: { value: "focus-choice" },
    });
    expect(within(focusPanel).getByText("我选择的专注任务")).toBeTruthy();
    fireEvent.click(within(focusPanel).getByRole("button", { name: "开始" }));
    expect(
      within(focusPanel).getByRole("button", { name: "暂停" }),
    ).toBeTruthy();
  });

  it("exposes overdue manual tasks through the same editable task drawer", () => {
    seedTasks([
      {
        id: "manual-overdue",
        title: "过期但可修改",
        source: "手动",
        progress: 0,
        deadlineAt: new Date(Date.now() - 3_600_000).toISOString(),
        importance: "medium",
        sourceLocked: false,
      },
    ]);
    render(<App />);
    const primaryNavigation = screen.getByRole("navigation", {
      name: "主导航",
    });
    fireEvent.click(
      within(primaryNavigation).getByRole("button", { name: /过期任务/ }),
    );
    expect(screen.getByRole("table", { name: "过期任务" })).toBeTruthy();
    fireEvent.click(screen.getAllByRole("row")[1]);
    expect(screen.getByRole("button", { name: "编辑任务" })).toBeTruthy();
  });

  it("shows real daily completion metrics and the completed ledger", () => {
    const deadline = new Date();
    deadline.setHours(23, 59, 0, 0);
    seedTasks([
      {
        id: "due-today",
        title: "今天仍待完成",
        source: "手动",
        progress: 0,
        deadlineAt: deadline.toISOString(),
      },
    ]);
    seedCompletionHistory([
      createCompletionRecord(
        {
          id: "finished-today",
          title: "今天已经完成",
          source: "手动",
          deadlineAt: deadline.toISOString(),
        },
        new Date().toISOString(),
      ),
    ]);

    render(<App />);
    expect(screen.getByText("50%")).toBeTruthy();
    expect(screen.getByText("完成任务 1 / 2")).toBeTruthy();
    expect(screen.getByText("0小时0分")).toBeTruthy();

    const primaryNavigation = screen.getByRole("navigation", {
      name: "主导航",
    });
    fireEvent.click(
      within(primaryNavigation).getByRole("button", { name: /今日完成/ }),
    );
    expect(screen.getByRole("list", { name: "今日完成任务" })).toBeTruthy();
    expect(screen.getByText("今天已经完成")).toBeTruthy();
  });

  it("archives a manually completed task instead of deleting its history", () => {
    seedTasks([
      {
        id: "manual-finish",
        title: "完成后留痕",
        source: "手动",
        progress: 80,
        deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
        sourceLocked: false,
      },
    ]);
    render(<App />);
    fireEvent.click(screen.getAllByRole("row")[1]);
    fireEvent.click(screen.getByRole("button", { name: "完成并归档" }));

    const primaryNavigation = screen.getByRole("navigation", {
      name: "主导航",
    });
    fireEvent.click(
      within(primaryNavigation).getByRole("button", { name: /今日完成/ }),
    );
    expect(screen.getByText("完成后留痕")).toBeTruthy();
    expect(screen.getByText("1 项")).toBeTruthy();
  });

  it("edits and deletes manually completed records while keeping imported records read-only", () => {
    const manual = createCompletionRecord(
      {
        id: "manual-completed",
        title: "完成记录可修改",
        source: "手动",
        deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
      new Date().toISOString(),
    );
    const imported = createCompletionRecord(
      {
        id: "zju:completed",
        title: "平台完成记录",
        source: "学在浙大",
        deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
      new Date().toISOString(),
      "source-sync",
    );
    seedCompletionHistory([manual, imported]);
    render(<App />);
    const primaryNavigation = screen.getByRole("navigation", {
      name: "主导航",
    });
    fireEvent.click(
      within(primaryNavigation).getByRole("button", { name: /今日完成/ }),
    );
    fireEvent.click(screen.getByText("完成记录可修改"));
    fireEvent.change(screen.getByLabelText("任务名称"), {
      target: { value: "完成记录已修改" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存记录" }));
    expect(screen.getByText("完成记录已修改")).toBeTruthy();

    fireEvent.click(screen.getByText("完成记录已修改"));
    fireEvent.click(screen.getByRole("button", { name: "删除记录" }));
    expect(screen.queryByText("完成记录已修改")).toBeNull();
    expect(screen.getByText("平台完成记录")).toBeTruthy();
  });

  it("opens the goals view and its creation form", () => {
    render(<App />);
    const primaryNavigation = screen.getByRole("navigation", {
      name: "主导航",
    });
    fireEvent.click(
      within(primaryNavigation).getByRole("button", { name: "目标" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "新建目标" }));

    expect(screen.getByRole("dialog", { name: "新建目标" })).toBeTruthy();
    expect(screen.getByPlaceholderText("例如：完成本学期课程")).toBeTruthy();
  });

  it("edits and deletes goals without deleting associated tasks", () => {
    seedGoals([
      {
        id: "goal-edit",
        name: "需要修改的目标",
        description: "旧说明",
        progress: 10,
        target: "2030-01-01",
        next: "旧下一项",
      },
    ]);
    render(<App />);
    const primaryNavigation = screen.getByRole("navigation", {
      name: "主导航",
    });
    fireEvent.click(
      within(primaryNavigation).getByRole("button", { name: "目标" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "编辑目标 需要修改的目标" }),
    );
    fireEvent.change(screen.getByLabelText("目标名称"), {
      target: { value: "已修改的目标" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存目标" }));
    expect(screen.getByText("已修改的目标")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "删除目标 已修改的目标" }),
    );
    expect(screen.queryByText("已修改的目标")).toBeNull();
  });

  it("keeps imported completion progress read-only", () => {
    seedTasks([
      {
        id: "zju:99089:test",
        title: "Lab0",
        source: "学在浙大",
        progress: 50,
        sourceProgressEstimated: true,
        deadlineAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        sourceLocked: true,
      },
    ]);
    render(<App />);
    const rows = screen.getAllByRole("row");
    fireEvent.click(rows[1]);

    const slider = screen.getByRole("slider");
    expect(slider.disabled).toBe(true);
    expect(screen.getAllByText("部分完成").length).toBeGreaterThan(0);
    expect(screen.getByText(/部分完成（平台未提供百分比）/)).toBeTruthy();
    expect(screen.getByText(/同步，无法手动修改/)).toBeTruthy();
  });

  it("migrates legacy source labels before rendering persisted tasks", () => {
    seedTasks([
      {
        id: "pintia:legacy",
        title: "旧来源名称任务",
        source: "Pintia",
        progress: 20,
        deadlineAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        sourceLocked: true,
      },
    ]);
    render(<App />);
    expect(screen.getByText("PTA")).toBeTruthy();
    expect(screen.queryByText("Pintia")).toBeNull();
  });

  it("starts and pauses the single focus timer", () => {
    render(<App />);
    const focusPanel = screen.getByText("当前专注").closest("section");
    fireEvent.click(within(focusPanel).getByRole("button", { name: "开始" }));
    expect(
      within(focusPanel).getByRole("button", { name: "暂停" }),
    ).toBeTruthy();
    fireEvent.click(within(focusPanel).getByRole("button", { name: "暂停" }));
    expect(
      within(focusPanel).getByRole("button", { name: "继续" }),
    ).toBeTruthy();
  });

  it("creates a custom pomodoro mode", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "调整模式" }));
    fireEvent.change(screen.getByLabelText("专注分钟"), {
      target: { value: "50" },
    });
    fireEvent.change(screen.getByLabelText("休息分钟"), {
      target: { value: "20" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存模式" }));
    expect(screen.getByRole("button", { name: "50+20" })).toBeTruthy();
  });

  it("manages the permanent work-domain whitelist", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    fireEvent.change(screen.getByLabelText("添加工作网站域名"), {
      target: { value: "https://docs.example.com/guide" },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加域名" }));
    expect(screen.getByText("docs.example.com")).toBeTruthy();
  });

  it("pauses focus when the Edge bridge reports a non-whitelisted domain", () => {
    render(<App />);
    const focusPanel = screen.getByText("当前专注").closest("section");
    fireEvent.click(within(focusPanel).getByRole("button", { name: "开始" }));
    fireEvent(
      window,
      new CustomEvent("fuck-ddl:domain-threshold", {
        detail: { domain: "video.example.com" },
      }),
    );
    expect(
      within(focusPanel).getByText("摸鱼 · video.example.com"),
    ).toBeTruthy();
    fireEvent.click(
      within(focusPanel).getByRole("button", { name: "继续专注" }),
    );
    expect(
      within(focusPanel).getByRole("button", { name: "暂停" }),
    ).toBeTruthy();
  });
});
