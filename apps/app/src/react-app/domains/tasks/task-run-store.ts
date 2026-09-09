/**
 * Local link between an intake task and the session that ran it.
 *
 * Session content is local by design, so the platform never learns which
 * session (or which folder) a task was worked in — it only ever receives the
 * content-free `lastLocalRunAt` marker on the task PATCH. That makes this map
 * the only place the link exists, which is why it is persisted per machine.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type IntakeTaskLocalRun = {
  workspaceId: string;
  sessionId: string;
  /** Epoch millis the run was started from this machine. */
  startedAt: number;
  /** Workflow (skill) name the run was seeded with — shown next to the link. */
  workflowName: string;
};

type TaskRunState = {
  runsByTaskId: Record<string, IntakeTaskLocalRun>;
};

type TaskRunActions = {
  recordRun: (taskId: string, run: IntakeTaskLocalRun) => void;
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
