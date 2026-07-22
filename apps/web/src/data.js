export const initialTasks = [];

export const initialGoals = [];

export function createInitialTasks(now = Date.now()) {
  return initialTasks.map((task) => ({
    ...task,
    deadlineAt: new Date(
      now + task.deadlineHours * 60 * 60 * 1000,
    ).toISOString(),
  }));
}
