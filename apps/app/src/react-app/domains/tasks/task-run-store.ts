/**
 * The last run started from a task on this machine, kept in the renderer.
 *
 * The task itself remembers every session tied to it (the server's
 * `sessions` list, which the task detail shows); this map only carries the
 * task's title into the chat, where the task badge is labelled from it while
 * the message itself names the task by id (task-reference.ts).
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type TaskLocalRun = {
  workspaceId: string;
  sessionId: string;
  /** Epoch millis the run was started from this machine. */
  startedAt: number;
  /** Workflow (skill) name the run was seeded with; null for a plain session. */
  workflowName: string | null;
  /** The task's title when the run started. Labels the task badge in the chat,
   *  whose message itself only carries the id (task-reference.ts). */
  taskTitle?: string;
};

type TaskRunState = {
  runsByTaskId: Record<string, TaskLocalRun>;
};

type TaskRunActions = {
  recordRun: (taskId: string, run: TaskLocalRun) => void;
  forgetRun: (taskId: string) => void;
};

export const useTaskRunStore = create<TaskRunState & TaskRunActions>()(
  persist(
    (set) => ({
      runsByTaskId: {},
      recordRun: (taskId, run) =>
        set((state) => ({ runsByTaskId: { ...state.runsByTaskId, [taskId]: run } })),
      forgetRun: (taskId) =>
        set((state) => {
          if (!(taskId in state.runsByTaskId)) return state;
          const next = { ...state.runsByTaskId };
          delete next[taskId];
          return { runsByTaskId: next };
        }),
    }),
    {
      name: "legalwork.intakeTaskRuns",
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
