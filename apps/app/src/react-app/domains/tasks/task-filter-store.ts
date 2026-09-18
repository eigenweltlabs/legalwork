import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export const TASK_FILTER_ASSIGNEE_ME = "__me__";

export type TaskSortKey = "created" | "updated" | "due" | "priority";
export type TaskStatusValue = "open" | "in_progress" | "done";

type TaskFilterState = {
  view: "tasks" | "trash";
  assignees: string[];
  statuses: TaskStatusValue[];
  endpointIds: string[];
  tags: string[];
  sort: TaskSortKey;
  setView: (value: "tasks" | "trash") => void;
  setAssignees: (value: string[]) => void;
  setStatuses: (value: TaskStatusValue[]) => void;
  setEndpointIds: (value: string[]) => void;
  setTags: (value: string[]) => void;
  setSort: (value: TaskSortKey) => void;
  clear: () => void;
};

const defaults = {
  view: "tasks" as const,
  assignees: [] as string[],
  statuses: [] as TaskStatusValue[],
  endpointIds: [] as string[],
  tags: [] as string[],
  sort: "created" as const,
};

/** The Tasks pane is mounted inside the current session route, so persist its
 * view preferences independently of that route (and across app restarts). */
export const useTaskFilterStore = create<TaskFilterState>()(
  persist(
    (set) => ({
      ...defaults,
      setView: (view) => set({ view }),
      setAssignees: (assignees) => set({ assignees }),
      setStatuses: (statuses) => set({ statuses }),
      setEndpointIds: (endpointIds) => set({ endpointIds }),
      setTags: (tags) => set({ tags }),
      setSort: (sort) => set({ sort }),
      clear: () => set(defaults),
    }),
    {
      // New key intentionally leaves the short-lived exclusion-filter shape behind.
      name: "legalwork.taskFilters.v2",
      storage: createJSONStorage(() => localStorage),
      partialize: ({ view, assignees, statuses, endpointIds, tags, sort }) => ({
        view,
        assignees,
        statuses,
        endpointIds,
        tags,
        sort,
      }),
    },
  ),
);
