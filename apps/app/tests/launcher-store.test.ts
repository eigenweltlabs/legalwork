import { expect, test } from "bun:test";
import { useLauncherStore } from "../src/react-app/launcher/launcher-store";

const conversation = { id: "conv_1", workspaceId: "assistant", sessionId: "ses_1", title: "Müller", kind: "conversation" as const, date: null, createdAt: 1, updatedAt: 1, pinned: false, archivedAt: null, origin: null };
test("hiding the panel clears a typed search but keeps a conversation draft", () => {
  const store = useLauncherStore.getState();
  store.bindConversation(conversation);
  store.setCategory("files"); store.setInput("Mietvertrag"); store.setView("results");
  store.reset();
  expect(useLauncherStore.getState()).toMatchObject({ view: "idle", input: "", category: null });
  store.setInput("Was ist offen?"); store.setView("conversation");
  store.reset();
  expect(useLauncherStore.getState()).toMatchObject({ view: "conversation", input: "Was ist offen?" });
  expect(useLauncherStore.getState().conversation?.pinned).toBe(false);
});

test("late search updates cannot steal a home, command or calculator selection", () => {
  const store = useLauncherStore.getState();
  for (const view of ["idle", "commands", "results"] as const) {
    store.setView(view);
    store.select({ id: view === "results" ? "calculator" : "home:new", source: "user" });
    const selection = useLauncherStore.getState().selection;
    store.setResults([], [], false, null);
    expect(useLauncherStore.getState().selection).toEqual(selection);
  }
});

test("typing a new search resets selection, while restoring a view keeps its chosen row", () => {
  const store = useLauncherStore.getState();
  store.setView("results"); store.select({ id: "old", source: "user" });
  store.setInput("different query");
  expect(useLauncherStore.getState().selection).toEqual({ id: null, source: "auto" });
  store.setView("conversation"); store.setView("results"); store.select({ id: "restored", source: "user" });
  expect(useLauncherStore.getState().selection.id).toBe("restored");
  store.setView("conversation"); store.select({ id: "command:old", source: "user" }); store.setInput("/new");
  expect(useLauncherStore.getState().selection).toEqual({ id: null, source: "auto" });
});

test("attached tasks survive a fresh screen selection and dismissal, and remain removable", () => {
  const store = useLauncherStore.getState();
  store.replaceContext([]);
  store.addContext([{ id: "task_one", type: "task", taskId: "one", workspaceId: "project", title: "Review agreement" }]);
  store.addContext([{ id: "sel_new", type: "selection", text: "New selection", sourceApp: "Safari", sourceWindow: null, capturedAt: 1 }]);
  store.addContext([{ id: "sel_latest", type: "selection", text: "Latest selection", sourceApp: "Safari", sourceWindow: null, capturedAt: 2 }]);
  expect(useLauncherStore.getState().context.map(item => item.id)).toEqual(["task_one", "sel_latest"]);
  store.reset();
  expect(useLauncherStore.getState().context).toEqual([{ id: "task_one", type: "task", taskId: "one", workspaceId: "project", title: "Review agreement" }]);
  store.removeContext("task_one");
  expect(useLauncherStore.getState().context).toEqual([]);
});

test("file sources combine with other filters, clear on category change and reset on dismissal", () => {
  const store = useLauncherStore.getState();
  store.setView("results"); store.setCategory("files");
  store.setFileFilter({ sourceKind: "wiki", types: ["pdf"], modifiedAfter: 10 });
  store.setFileFilter({ modifiedAfter: 20 });
  expect(useLauncherStore.getState().fileFilter).toEqual({ sourceKind: "wiki", types: ["pdf"], modifiedAfter: 20 });
  store.setCategory("tasks");
  expect(useLauncherStore.getState().fileFilter).toEqual({ sourceKind: null, types: null, modifiedAfter: 20 });
  store.setCategory("files"); store.setFileFilter({ sourceKind: "project" });
  store.reset();
  expect(useLauncherStore.getState().fileFilter).toEqual({ sourceKind: null, types: null, modifiedAfter: null });
});

test("explicit hide preserves an in-flight task editor, then ordinary dismissal resets again", () => {
  const store = useLauncherStore.getState();
  const detail = { result: { id: "task-saving", kind: "tasks", workspaceId: "matter", sourceId: "tasks", title: "Saving", updatedAt: 1, score: 0, match: "recent", actions: ["open"] } } satisfies NonNullable<ReturnType<typeof useLauncherStore.getState>["detail"]>;
  useLauncherStore.setState({ view: "detail", detail, input: "", formBusy: true, notice: { tone: "error", text: "Save is still pending" } });
  store.setVisible(false);
  store.reset();
  expect(useLauncherStore.getState()).toMatchObject({ visible: false, view: "detail", detail, formBusy: true, notice: { text: "Save is still pending" } });
  useLauncherStore.setState({ formBusy: false });
  store.setVisible(true);
  expect(useLauncherStore.getState().detail).toEqual(detail);
  store.setVisible(false);
  store.reset();
  expect(useLauncherStore.getState()).toMatchObject({ view: "idle", detail: null, formBusy: false, notice: null });
  store.setVisible(true);
});

test("each opening distinguishes a pending origin, a foreground project and an external app", () => {
  const store = useLauncherStore.getState();
  const project = { workspaceId: "B", workspaceName: "Second project", capturedAt: 12 };
  store.setVisible(false);
  store.setVisible(true);
  expect(useLauncherStore.getState().invocationContext).toBeUndefined();
  store.setInvocation({ id: "cold", source: "shortcut", action: "open", workspaceContext: project });
  expect(useLauncherStore.getState().invocationContext).toEqual(project);
  store.setInvocation(null);
  expect(useLauncherStore.getState().invocationContext).toEqual(project);
  store.setVisible(false);
  store.setVisible(true);
  expect(useLauncherStore.getState().invocationContext).toBeUndefined();
  store.setInvocation({ id: "external", source: "shortcut", action: "open" });
  expect(useLauncherStore.getState().invocationContext).toBeNull();
  store.setInvocation(null);
});
