/**
 * What the user wants to hear about tasks (Settings > Notifications). Kept on
 * this computer, like the notification center the announcements land in.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export const TASK_NOTIFICATION_PREFERENCES_KEY = "legalwork:task-notifications:v1";

/**
 * Which tasks are announced: the user's own (assigned to them, or filed by
 * them and not assigned), those plus every unassigned one, or every task
 * they can see.
 */
export type TaskNotificationScope = "mine" | "unassigned" | "all";

export type TaskNotificationPreferences = {
  /** A task arrived from the firm, or was assigned to the user. */
  arrivals: boolean;
  dueToday: boolean;
  overdue: boolean;
  scope: TaskNotificationScope;
  /** Also a system notification while LegalWork is in the background. */
  system: boolean;
};

export const DEFAULT_TASK_NOTIFICATION_PREFERENCES: TaskNotificationPreferences = {
  arrivals: true,
  dueToday: true,
  overdue: true,
  scope: "mine",
  system: true,
};

function isScope(value: unknown): value is TaskNotificationScope {
  return value === "mine" || value === "unassigned" || value === "all";
}

/** Stored settings, field by field: anything missing or malformed keeps its default. */
export function sanitizeTaskNotificationPreferences(value: unknown): TaskNotificationPreferences {
  const defaults = DEFAULT_TASK_NOTIFICATION_PREFERENCES;
  if (typeof value !== "object" || value === null) return { ...defaults };
  const flag = (key: "arrivals" | "dueToday" | "overdue" | "system") => {
    const stored = Reflect.get(value, key);
    return typeof stored === "boolean" ? stored : defaults[key];
  };
  const scope = Reflect.get(value, "scope");
  return {
    arrivals: flag("arrivals"),
    dueToday: flag("dueToday"),
    overdue: flag("overdue"),
    scope: isScope(scope) ? scope : defaults.scope,
    system: flag("system"),
  };
}

type TaskNotificationPreferencesStore = TaskNotificationPreferences & {
  update: (patch: Partial<TaskNotificationPreferences>) => void;
};

export const useTaskNotificationPreferences = create<TaskNotificationPreferencesStore>()(
  persist(
    (set) => ({
      ...DEFAULT_TASK_NOTIFICATION_PREFERENCES,
      update: (patch) => set(patch),
    }),
    {
      name: TASK_NOTIFICATION_PREFERENCES_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: ({ arrivals, dueToday, overdue, scope, system }) => ({ arrivals, dueToday, overdue, scope, system }),
      merge: (persisted, current) => ({ ...current, ...sanitizeTaskNotificationPreferences(persisted) }),
    },
  ),
);
