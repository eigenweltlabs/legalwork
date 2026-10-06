/**
 * What the user wants to hear about tasks (Settings > Notifications). Kept on
 * this computer, like the notification center the announcements land in. The
 * firm may set some of it (Default settings → Notifications): its values apply
 * over the member's own.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { appliedOrgPolicy, changeOrgPolicySetting, useOrgPolicy, useOrgPolicyStore } from "../connections/org-policy";

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
  /** The unread count on the app icon (Dock, launcher, taskbar). */
  appBadge: boolean;
};

export const DEFAULT_TASK_NOTIFICATION_PREFERENCES: TaskNotificationPreferences = {
  arrivals: true,
  dueToday: true,
  overdue: true,
  scope: "mine",
  system: true,
  appBadge: true,
};

function isScope(value: unknown): value is TaskNotificationScope {
  return value === "mine" || value === "unassigned" || value === "all";
}

/** Stored settings, field by field: anything missing or malformed keeps its default. */
export function sanitizeTaskNotificationPreferences(value: unknown): TaskNotificationPreferences {
  const defaults = DEFAULT_TASK_NOTIFICATION_PREFERENCES;
  if (typeof value !== "object" || value === null) return { ...defaults };
  const flag = (key: "arrivals" | "dueToday" | "overdue" | "system" | "appBadge") => {
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
    appBadge: flag("appBadge"),
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
      partialize: ({ arrivals, dueToday, overdue, scope, system, appBadge }) => ({
        arrivals,
        dueToday,
        overdue,
        scope,
        system,
        appBadge,
      }),
      merge: (persisted, current) => ({ ...current, ...sanitizeTaskNotificationPreferences(persisted) }),
    },
  ),
);

function firmPreferences() {
  return appliedOrgPolicy(useOrgPolicyStore.getState().view, "notifications")?.value;
}

/** The preferences in effect: the firm's over the member's own. */
export function taskNotificationPreferences(): TaskNotificationPreferences {
  return { ...sanitizeTaskNotificationPreferences(useTaskNotificationPreferences.getState()), ...firmPreferences() };
}

/** One preference in effect, and whether the firm locked it. */
export function useTaskNotificationPreference<K extends keyof TaskNotificationPreferences>(field: K) {
  const own = useTaskNotificationPreferences((state) => state[field]);
  const firm = useOrgPolicy("notifications");
  const firmValue = firm?.value[field];
  return { value: firmValue ?? own, locked: firm?.locked === true && firmValue !== undefined };
}

/**
 * Change the member's own preferences. Changing one the firm sets takes the
 * firm's settings back first (asking after sign-out), keeping its other values.
 */
export async function changeTaskNotificationPreferences(patch: Partial<TaskNotificationPreferences>): Promise<void> {
  const firm = firmPreferences();
  const { update } = useTaskNotificationPreferences.getState();
  if (!firm || !Object.keys(patch).some((field) => Object.hasOwn(firm, field))) return update(patch);
  await changeOrgPolicySetting("notifications", () => update({ ...firm, ...patch }));
}
