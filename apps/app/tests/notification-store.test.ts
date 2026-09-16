import { beforeEach, describe, expect, test } from "bun:test";

// Minimal localStorage stub so the persisted zustand store works under bun.
const storage = new Map<string, string>();
const localStorageStub = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => {
    storage.set(key, value);
  },
  removeItem: (key: string) => {
    storage.delete(key);
  },
  clear: () => storage.clear(),
  key: (index: number) => [...storage.keys()][index] ?? null,
  get length() {
    return storage.size;
  },
};
Object.defineProperty(globalThis, "localStorage", {
  value: localStorageStub,
  configurable: true,
});

const { countUnreadTasks, useNotificationStore } = await import("../src/react-app/kernel/notification-store");

function reset() {
  useNotificationStore.setState({ notifications: [] });
  storage.clear();
}

describe("notification store", () => {
  beforeEach(reset);

  test("add creates an unread entry", () => {
    useNotificationStore.getState().add({
      kind: "system",
      title: "Something happened",
      body: "Details",
    });

    const notifications = useNotificationStore.getState().notifications;
    expect(notifications).toHaveLength(1);
    expect(notifications[0].title).toBe("Something happened");
    expect(notifications[0].severity).toBe("info");
    expect(notifications[0].readAt).toBeNull();
    expect(notifications[0].count).toBe(1);
  });

  test("dedupeKey coalesces into the existing unread entry", () => {
    const { add } = useNotificationStore.getState();
    add({ kind: "providers", title: "1 new provider available", dedupeKey: "new-providers" });
    add({ kind: "providers", title: "2 new providers available", dedupeKey: "new-providers" });

    const notifications = useNotificationStore.getState().notifications;
    expect(notifications).toHaveLength(1);
    expect(notifications[0].title).toBe("2 new providers available");
    expect(notifications[0].count).toBe(2);
  });

  test("read entries do not absorb new events", () => {
    const { add, markAllRead } = useNotificationStore.getState();
    add({ kind: "providers", title: "1 new provider available", dedupeKey: "new-providers" });
    markAllRead();
    add({ kind: "providers", title: "1 new provider available", dedupeKey: "new-providers" });

    const notifications = useNotificationStore.getState().notifications;
    expect(notifications).toHaveLength(2);
    expect(notifications[0].readAt).toBeNull();
    expect(notifications[1].readAt).not.toBeNull();
  });

  test("coalescing keeps merged fields when the update omits them", () => {
    const { add } = useNotificationStore.getState();
    add({
      kind: "reload",
      title: "Updates pending",
      body: "Will apply when tasks finish.",
      dedupeKey: "engine-reload",
      severity: "info",
    });
    add({
      kind: "reload",
      title: "Updates applied",
      dedupeKey: "engine-reload",
      severity: "success",
    });

    const [entry] = useNotificationStore.getState().notifications;
    expect(entry.title).toBe("Updates applied");
    expect(entry.severity).toBe("success");
    expect(entry.body).toBe("Will apply when tasks finish.");
  });

  test("markAllRead is a no-op when everything is read", () => {
    const { add, markAllRead } = useNotificationStore.getState();
    add({ kind: "system", title: "One" });
    markAllRead();
    const before = useNotificationStore.getState().notifications;
    markAllRead();
    expect(useNotificationStore.getState().notifications).toBe(before);
  });

  test("clearAll empties the list", () => {
    const { add, clearAll } = useNotificationStore.getState();
    add({ kind: "system", title: "One" });
    add({ kind: "system", title: "Two" });
    clearAll();
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
  });

  test("unread task announcements count their tasks once, until their kind is read", () => {
    const { add, markKindRead } = useNotificationStore.getState();
    const tasks = (ids: string[], total = ids.length) => ({
      type: "open-tasks" as const,
      tasks: ids.map((id) => ({ id, title: id.toUpperCase() })),
      total,
    });
    add({ kind: "tasks", title: "Assigned", dedupeKey: "tasks:assigned", action: tasks(["a", "b"]) });
    add({ kind: "tasks", title: "Overdue", dedupeKey: "tasks:overdue", action: tasks(["b", "c"], 5) });
    add({ kind: "system", title: "Other" });
    // a, b, c named, and 3 more the overdue entry counts past what it kept.
    expect(countUnreadTasks(useNotificationStore.getState().notifications)).toBe(6);

    markKindRead("tasks");
    const after = useNotificationStore.getState().notifications;
    expect(countUnreadTasks(after)).toBe(0);
    expect(after.find((entry) => entry.kind === "system")?.readAt).toBeNull();
    markKindRead("tasks");
    expect(useNotificationStore.getState().notifications).toBe(after);
  });

  test("removeKind drops one kind and keeps the rest", () => {
    const { add, removeKind } = useNotificationStore.getState();
    add({ kind: "tasks", title: "Overdue", dedupeKey: "tasks:overdue" });
    add({ kind: "system", title: "Kept" });
    removeKind("tasks");
    expect(useNotificationStore.getState().notifications.map((entry) => entry.title)).toEqual(["Kept"]);
    const before = useNotificationStore.getState().notifications;
    removeKind("tasks");
    expect(useNotificationStore.getState().notifications).toBe(before);
  });

  test("a task entry and its action survive a reload; a malformed action does not", async () => {
    const { add } = useNotificationStore.getState();
    add({
      kind: "tasks",
      title: "2 tasks overdue",
      dedupeKey: "tasks:overdue",
      action: { type: "open-tasks", tasks: [{ id: "a", title: "A" }, { id: "b", title: "B" }], total: 2 },
      actionLabel: "Show tasks",
    });
    const persisted = JSON.parse(storage.get("legalwork:notifications:v1") ?? "{}");
    persisted.state.notifications.push({
      ...persisted.state.notifications[0],
      id: "ntf_broken",
      action: { type: "open-tasks", tasks: [{ id: 1 }], total: 1 },
    });
    // Emptying the store writes through, so the stored copy goes back after it.
    useNotificationStore.setState({ notifications: [] });
    storage.set("legalwork:notifications:v1", JSON.stringify(persisted));
    await useNotificationStore.persist.rehydrate();

    const [entry, broken] = useNotificationStore.getState().notifications;
    expect(entry.kind).toBe("tasks");
    expect(entry.action).toEqual({ type: "open-tasks", tasks: [{ id: "a", title: "A" }, { id: "b", title: "B" }], total: 2 });
    expect(broken.id).toBe("ntf_broken");
    expect(broken.action).toBeUndefined();
  });

  test("caps the list at 100 entries", () => {
    const { add } = useNotificationStore.getState();
    for (let index = 0; index < 110; index += 1) {
      add({ kind: "system", title: `Entry ${index}` });
    }
    const notifications = useNotificationStore.getState().notifications;
    expect(notifications).toHaveLength(100);
    expect(notifications[0].title).toBe("Entry 109");
  });
});
