import { afterEach, describe, expect, test } from "bun:test";

// The preference store persists through localStorage; bun has none.
const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear(),
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() {
      return storage.size;
    },
  },
  configurable: true,
});

const { setLocale } = await import("../src/i18n");
const {
  selectTaskAnnouncements,
  taskAnnouncementTarget,
  taskAnnouncementText,
  taskCenterEntry,
  taskSystemNotificationId,
  taskSystemNotificationTarget,
} = await import("../src/react-app/domains/tasks/task-notifications");
const {
  DEFAULT_TASK_NOTIFICATION_PREFERENCES,
  TASK_NOTIFICATION_PREFERENCES_KEY,
  sanitizeTaskNotificationPreferences,
  useTaskNotificationPreferences,
} = await import("../src/react-app/domains/tasks/task-notification-preferences");
const { requestTasksPane, takePendingTasksPaneRequest, TASKS_PANE_OPEN_EVENT } = await import("../src/react-app/domains/tasks/tasks-pane-request");
const { isSessionViewPath } = await import("../src/react-app/shell/show-tasks-pane");

import type { LegalworkTaskNotification } from "../src/app/lib/legalwork-server";
import type { AppNotification } from "../src/react-app/kernel/notification-store";

afterEach(() => {
  setLocale("en");
});

let sequence = 0;
function notification(overrides: Partial<LegalworkTaskNotification> & Pick<LegalworkTaskNotification, "kind" | "taskId">): LegalworkTaskNotification {
  sequence += 1;
  return {
    id: `n-${sequence}`,
    title: `Task ${overrides.taskId}`,
    origin: "intake",
    dueDate: null,
    audience: "mine",
    createdAt: "2026-09-16T09:00:00.000Z",
    ...overrides,
  };
}

const everything = { ...DEFAULT_TASK_NOTIFICATION_PREFERENCES, scope: "all" as const };

/** Local midnight `days` from today, as the app stores a date-only due date. */
function dueInDays(days: number): string {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

describe("selecting what to announce", () => {
  test("groups by kind, the user's own first, each task once", () => {
    const announcements = selectTaskAnnouncements(
      [
        notification({ kind: "due_today", taskId: "a" }),
        notification({ kind: "new", taskId: "b" }),
        notification({ kind: "overdue", taskId: "c" }),
        notification({ kind: "assigned", taskId: "d" }),
        notification({ kind: "new", taskId: "b" }),
      ],
      everything,
    );
    expect(announcements.map((announcement) => [announcement.kind, announcement.tasks.map((task) => task.id)])).toEqual([
      ["assigned", ["d"]],
      ["new", ["b"]],
      ["overdue", ["c"]],
      ["due_today", ["a"]],
    ]);
  });

  test("an arriving task is not announced again for its due day", () => {
    const announcements = selectTaskAnnouncements(
      [
        notification({ kind: "assigned", taskId: "a", dueDate: dueInDays(-2) }),
        notification({ kind: "overdue", taskId: "a", dueDate: dueInDays(-2) }),
        notification({ kind: "overdue", taskId: "b", dueDate: dueInDays(-1) }),
      ],
      everything,
    );
    expect(announcements.map((announcement) => [announcement.kind, announcement.tasks.map((task) => task.id)])).toEqual([
      ["assigned", ["a"]],
      ["overdue", ["b"]],
    ]);
    // …but when arrivals are off, its due day still is.
    const dueOnly = selectTaskAnnouncements(
      [notification({ kind: "assigned", taskId: "a" }), notification({ kind: "overdue", taskId: "a" })],
      { ...everything, arrivals: false },
    );
    expect(dueOnly.map((announcement) => announcement.kind)).toEqual(["overdue"]);
  });

  test("follows the kinds and the scope the user chose", () => {
    const claim = [
      notification({ kind: "new", taskId: "mine", audience: "mine" }),
      notification({ kind: "new", taskId: "open", audience: "unassigned" }),
      notification({ kind: "new", taskId: "bobs", audience: "others" }),
      notification({ kind: "due_today", taskId: "today" }),
      notification({ kind: "overdue", taskId: "late" }),
    ];
    const ids = (preferences: typeof everything) =>
      selectTaskAnnouncements(claim, preferences).flatMap((announcement) => announcement.tasks.map((task) => task.id));
    expect(ids({ ...everything, scope: "mine" })).toEqual(["mine", "late", "today"]);
    expect(ids({ ...everything, scope: "unassigned" })).toEqual(["mine", "open", "late", "today"]);
    expect(ids(everything)).toEqual(["mine", "open", "bobs", "late", "today"]);
    expect(ids({ ...everything, dueToday: false, overdue: false })).toEqual(["mine", "open", "bobs"]);
  });
});

describe("what an announcement says", () => {
  test("one task by its title, with its due day when it arrives due", () => {
    expect(taskAnnouncementText({ kind: "new", tasks: [{ id: "a", title: "Frist Meier", dueDate: null }] })).toEqual({
      title: "New task",
      body: "Frist Meier",
    });
    expect(taskAnnouncementText({ kind: "assigned", tasks: [{ id: "a", title: "Frist Meier", dueDate: dueInDays(0) }] })).toEqual({
      title: "Assigned to you",
      body: "Frist Meier · due today",
    });
    expect(taskAnnouncementText({ kind: "assigned", tasks: [{ id: "a", title: "Frist Meier", dueDate: dueInDays(-3) }] }).body).toBe(
      "Frist Meier · overdue",
    );
    expect(taskAnnouncementText({ kind: "overdue", tasks: [{ id: "a", title: "Frist Meier", dueDate: dueInDays(-3) }] })).toEqual({
      title: "Overdue",
      body: "Frist Meier",
    });
  });

  test("several by count, naming the first two", () => {
    const tasks = ["A", "B", "C", "D"].map((title) => ({ id: title.toLowerCase(), title, dueDate: null }));
    expect(taskAnnouncementText({ kind: "overdue", tasks })).toEqual({ title: "4 tasks overdue", body: "A, B and 2 more" });
    expect(taskAnnouncementText({ kind: "due_today", tasks: tasks.slice(0, 2) })).toEqual({ title: "2 tasks due today", body: "A, B" });
    expect(taskAnnouncementText({ kind: "new", tasks: tasks.slice(0, 3) }).body).toBe("A, B and 1 more");
  });

  test("in German", () => {
    setLocale("de");
    const tasks = ["A", "B", "C"].map((title) => ({ id: title.toLowerCase(), title, dueDate: null }));
    expect(taskAnnouncementText({ kind: "assigned", tasks })).toEqual({
      title: "3 Aufgaben Ihnen zugewiesen",
      body: "A, B und 1 weitere",
    });
    expect(taskAnnouncementText({ kind: "overdue", tasks: tasks.slice(0, 1) }).title).toBe("Überfällig");
  });

  test("a click opens the one task, or the list for several", () => {
    expect(taskAnnouncementTarget([{ id: "a", title: "A" }])).toBe("a");
    expect(taskAnnouncementTarget([{ id: "a", title: "A" }, { id: "b", title: "B" }])).toBeNull();
  });

  test("a system notification carries what it opens, so a click finds it after a reload", () => {
    const one = taskSystemNotificationId("5b0c7d1e-0000-4000-8000-000000000001", "x1");
    expect(taskSystemNotificationTarget(one)).toBe("5b0c7d1e-0000-4000-8000-000000000001");
    expect(taskSystemNotificationTarget(taskSystemNotificationId(null, "x2"))).toBeNull();
    expect(taskSystemNotificationTarget("update-ready")).toBeUndefined();
  });
});

describe("the notification center entry", () => {
  const unreadFrom = (input: ReturnType<typeof taskCenterEntry>): AppNotification => ({
    ...input,
    id: "ntf",
    severity: input.severity ?? "info",
    count: 1,
    createdAt: 1,
    updatedAt: 1,
    readAt: null,
  });

  test("gathers the tasks of its kind until it is read, newest first, each once", () => {
    const first = taskCenterEntry({ kind: "overdue", tasks: [{ id: "a", title: "A", dueDate: null }] });
    expect(first).toMatchObject({
      kind: "tasks",
      severity: "warning",
      dedupeKey: "tasks:overdue",
      title: "Overdue",
      body: "A",
      action: { type: "open-tasks", tasks: [{ id: "a", title: "A" }], total: 1 },
      actionLabel: "Open task",
    });

    const second = taskCenterEntry(
      {
        kind: "overdue",
        tasks: [
          { id: "b", title: "B", dueDate: null },
          { id: "a", title: "A", dueDate: null },
        ],
      },
      unreadFrom(first),
    );
    expect(second).toMatchObject({
      title: "2 tasks overdue",
      body: "B, A",
      action: { type: "open-tasks", tasks: [{ id: "b", title: "B" }, { id: "a", title: "A" }], total: 2 },
      actionLabel: "Show tasks",
    });
  });

  test("an arrival is plain information", () => {
    expect(taskCenterEntry({ kind: "new", tasks: [{ id: "a", title: "A", dueDate: null }] }).severity).toBe("info");
  });
});

describe("task notification settings", () => {
  test("default to everything about the user's own tasks, with system notifications", () => {
    expect(DEFAULT_TASK_NOTIFICATION_PREFERENCES).toEqual({
      arrivals: true,
      dueToday: true,
      overdue: true,
      scope: "mine",
      system: true,
    });
  });

  test("a stored value keeps what is valid and defaults the rest", () => {
    expect(sanitizeTaskNotificationPreferences({ overdue: false, scope: "everyone", system: "no" })).toEqual({
      ...DEFAULT_TASK_NOTIFICATION_PREFERENCES,
      overdue: false,
    });
    expect(sanitizeTaskNotificationPreferences(null)).toEqual(DEFAULT_TASK_NOTIFICATION_PREFERENCES);
  });

  test("are kept on this computer", async () => {
    useTaskNotificationPreferences.getState().update({ scope: "unassigned", system: false });
    const stored = storage.get(TASK_NOTIFICATION_PREFERENCES_KEY) ?? "{}";
    expect(JSON.parse(stored).state).toEqual({
      ...DEFAULT_TASK_NOTIFICATION_PREFERENCES,
      scope: "unassigned",
      system: false,
    });
    // A fresh start: the in-memory defaults (which write through), then the stored copy.
    useTaskNotificationPreferences.setState({ ...DEFAULT_TASK_NOTIFICATION_PREFERENCES });
    storage.set(TASK_NOTIFICATION_PREFERENCES_KEY, stored);
    await useTaskNotificationPreferences.persist.rehydrate();
    expect(useTaskNotificationPreferences.getState()).toMatchObject({ scope: "unassigned", system: false, overdue: true });
    useTaskNotificationPreferences.setState({ ...DEFAULT_TASK_NOTIFICATION_PREFERENCES });
  });
});

describe("opening a task from anywhere", () => {
  test("an ask is announced, waits briefly for the session view, and is taken once", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "window");
    const target = new EventTarget();
    const seen: Array<string | null> = [];
    target.addEventListener(TASKS_PANE_OPEN_EVENT, (event) => {
      seen.push((event as CustomEvent<{ taskId: string | null }>).detail.taskId);
    });
    Object.defineProperty(globalThis, "window", { value: target, configurable: true });
    try {
      requestTasksPane("task-1");
      expect(seen).toEqual(["task-1"]);
      expect(takePendingTasksPaneRequest()).toEqual({ taskId: "task-1" });
      expect(takePendingTasksPaneRequest()).toBeNull();

      requestTasksPane(null);
      expect(seen).toEqual(["task-1", null]);
      // Too old to act on: the user has moved on.
      expect(takePendingTasksPaneRequest(Date.now() + 60_000)).toBeNull();
    } finally {
      if (original) Object.defineProperty(globalThis, "window", original);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });

  test("knows which screens can show the Tasks pane", () => {
    expect(isSessionViewPath("/session")).toBe(true);
    expect(isSessionViewPath("/tasks")).toBe(true);
    expect(isSessionViewPath("/workspace/ws_1/session/ses_1")).toBe(true);
    expect(isSessionViewPath("/workspace/ws_1/evals")).toBe(true);
    expect(isSessionViewPath("/workspace/ws_1/settings/notifications")).toBe(false);
    expect(isSessionViewPath("/settings/general")).toBe(false);
    expect(isSessionViewPath("/welcome")).toBe(false);
  });
});
