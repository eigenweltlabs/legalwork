import { beforeEach, expect, test } from "bun:test";
import type { DynamicToolUIPart } from "ai";
import { reconcileViewGenerations, syncViewGeneration, visibleDashboardContext } from "../src/react-app/domains/views/view-generation-sync";
import { useViewGenerationStore, viewGenerationId, latestDraftId, viewToolOutcome, type ViewDraftTab } from "../src/react-app/domains/views/view-generation";
import { usePanelTabStore } from "../src/react-app/domains/session/panel/panel-tab-store";
import { parseDynamicToolUIPart } from "../src/react-app/domains/session/sync/parse-tool-parts";
import { getAssistantRenderGroups } from "../src/components/chat/utils";

const context = { serverUrl: "local", workspaceId: "wiki", sessionId: "session" };
const id = viewGenerationId("local", "session", "call");
const pending = { type: "dynamic-tool", toolName: "view_create", toolCallId: "call", state: "input-streaming", input: {} } satisfies DynamicToolUIPart;
const saved = { version: 1, id: "11111111-1111-4111-8111-111111111111", owner: { kind: "wiki", id: "wiki" }, title: "Live", program: 'root = Text("Hello")', queries: {}, catalog: "legalwork-1", mode: "dashboard", updatedAt: 1, revision: "r1" };
const done = { ...pending, state: "output-available", output: saved } satisfies DynamicToolUIPart;
const opened: ViewDraftTab[] = [];
const open = (tab: ViewDraftTab) => { opened.push(tab); usePanelTabStore.getState().openTab("workspace:wiki", tab); };
beforeEach(() => { opened.length = 0; useViewGenerationStore.setState({ entries: {}, savedResults: {} }); usePanelTabStore.setState({ sessions: {} }); });

test("a view opens immediately with empty args, before the first program token", async () => {
  const part = parseDynamicToolUIPart({ type: "tool", id: "part", messageID: "message", sessionID: "session", callID: "call", tool: "view_create", state: { status: "pending", raw: "", input: {} } });
  expect(part).not.toBeNull();
  await syncViewGeneration(context, part!, open);
  expect(opened).toHaveLength(1);
  expect(useViewGenerationStore.getState().entries[id]).toMatchObject({ program: "", status: "streaming" });
});
test("partial arguments render progressively and completion replaces the existing tab", async () => {
  await syncViewGeneration(context, pending, open);
  const stream = (rawInput: string) => syncViewGeneration(context, { ...pending, callProviderMetadata: { opencode: { rawInput } } }, open);
  await stream('{"input":{"title":"Live","program":"root = Text(\\"Hel');
  expect(useViewGenerationStore.getState().entries[id].program).toBe('root = Text("Hel');
  await stream('{"input":{"title":"Live","program":"root = Text(\\"Hello\\")"}}');
  expect(useViewGenerationStore.getState().entries[id].program).toBe(saved.program);
  const late = stream('{"input":{"program":"short');
  await syncViewGeneration(context, done, open);
  await late;
  expect(opened).toHaveLength(1);
  expect(useViewGenerationStore.getState().entries[id]).toMatchObject({ status: "saved", saved });
  expect(usePanelTabStore.getState().sessions["workspace:wiki"].tabs).toMatchObject([{ type: "view", viewId: saved.id }]);
});
test("history never auto-opens and manual closure is respected while streaming", async () => {
  await syncViewGeneration(context, { ...done, toolCallId: "old-call" }, open);
  expect(opened).toHaveLength(0);
  await syncViewGeneration(context, pending, open);
  usePanelTabStore.getState().closeTab("workspace:wiki", id);
  await syncViewGeneration(context, { ...pending, input: { input: { program: saved.program } } }, open);
  await syncViewGeneration(context, done, open);
  expect(opened).toHaveLength(1);
  expect(usePanelTabStore.getState().sessions["workspace:wiki"].tabs).toHaveLength(0);
});
test("saved report JSON with runtime reminders resolves the preview and repairs historical cards", async () => {
  const report = { ...saved, mode: "report", owner: { kind: "workspace", id: "project" } };
  const output = JSON.stringify(report, null, 2) + '\n\n<system-reminder topic="project-folders">\nFolders: {"folders":["Reports"]}\n</system-reminder>' + '\n\n<system-reminder topic="sidebar">\nReport is open\n</system-reminder>';
  const part = parseDynamicToolUIPart({ type: "tool", id: "part", messageID: "message", sessionID: "session", callID: "call", tool: "view_create", state: { status: "completed", input: {}, output, title: "Report", metadata: { truncated: false }, time: { start: 1, end: 2 } } });
  expect(part).not.toBeNull();
  await syncViewGeneration(context, pending, open);
  await syncViewGeneration(context, part!, open);
  expect(useViewGenerationStore.getState().entries[id]).toMatchObject({ status: "saved", saved: report });
  expect(usePanelTabStore.getState().sessions["workspace:wiki"].tabs).toMatchObject([{ type: "view", viewId: report.id }]);
  useViewGenerationStore.getState().update(id, { ...useViewGenerationStore.getState().entries[id], saved: undefined, status: "failed", error: "The agent did not return a saved view." });
  await reconcileViewGenerations(context, [part!]);
  expect(useViewGenerationStore.getState().entries[id]).toMatchObject({ status: "saved", saved: report });
  expect(useViewGenerationStore.getState().entries[id].error).toBeUndefined();
  expect(opened).toHaveLength(1);
});
test("project dashboards stream beside their chat and stay in that project's tabs", async () => {
  const project = { ...context, workspaceId: "project" };
  const scope = "workspace:project";
  usePanelTabStore.getState().openTab(scope, { type: "chat", id: "chat:session", sessionId: "session", label: "Chat" });
  const openProject = (tab: ViewDraftTab) => usePanelTabStore.getState().openTab(scope, tab, "main", undefined, { besideChat: true });
  await syncViewGeneration(project, pending, openProject);
  expect(usePanelTabStore.getState().sessions[scope].panes[1].activeTabId).toBe(id);
  await syncViewGeneration(project, { ...pending, input: { input: { program: 'root = Text("Invoice' } } }, openProject);
  expect(useViewGenerationStore.getState().entries[id].program).toBe('root = Text("Invoice');
  await syncViewGeneration(project, { ...done, output: { ...saved, owner: { kind: "workspace", id: "project" } } }, openProject);
  expect(usePanelTabStore.getState().sessions[scope].tabs).toContainEqual(expect.objectContaining({ type: "view", owner: { kind: "workspace", id: "project" } }));
  expect(usePanelTabStore.getState().sessions["workspace:wiki"]).toBeUndefined();
});
test("view cards stay outside collapsed generic tool groups", () => {
  const groups = getAssistantRenderGroups([pending], false);
  expect(groups).toMatchObject([{ kind: "view", part: pending }]);
});

test("an idle snapshot ends abandoned previews and records failed tool results without reopening tabs", async () => {
  await syncViewGeneration(context, pending, open);
  await reconcileViewGenerations(context, [pending]);
  expect(useViewGenerationStore.getState().entries[id]).toMatchObject({ status: "failed", error: "Generation stopped before this view was saved." });
  await syncViewGeneration(context, pending, open);
  expect(opened).toHaveLength(1);
  await reconcileViewGenerations(context, [{ ...done, output: JSON.stringify({ ok: false, error: "Query limit exceeded" }) }]);
  expect(useViewGenerationStore.getState().entries[id]).toMatchObject({ status: "failed", error: "Query limit exceeded" });
  const retry = { ...done, toolCallId: "retry" };
  await reconcileViewGenerations(context, [retry]);
  expect(useViewGenerationStore.getState().entries[viewGenerationId("local", "session", "retry")].status).toBe("saved");
  expect(opened).toHaveLength(1);
});

test.each([0, 1600])("a streamed dashboard opens beside chat even with a source pane (width %d)", width => {
  const scope = "workspace:wiki";
  const store = usePanelTabStore.getState();
  store.setWorkspaceWidth(scope, width);
  store.openTab(scope, { type: "chat", id: "chat:session", sessionId: "session", label: "Chat" });
  store.openTab(scope, { type: "view-draft", id, generationId: id, serverUrl: "local", label: "Generating" }, "main", undefined, { besideChat: true });
  const layout = usePanelTabStore.getState().sessions[scope];
  expect(layout.panes).toHaveLength(2);
  expect(layout.panes[0].activeTabId).toBe("chat:session");
  expect(layout.panes[1].activeTabId).toBe(id);
});

test("completed previews stay unsaved, can reopen from history, and replay never undoes a user save", async () => {
  const preview = { status: "preview", owner: saved.owner, input: { version: saved.version, title: saved.title, program: saved.program, queries: {}, catalog: saved.catalog, mode: saved.mode } };
  await syncViewGeneration(context, pending, open);
  await syncViewGeneration(context, { ...done, output: preview }, open);
  expect(useViewGenerationStore.getState().entries[id].status).toBe("preview");
  expect(useViewGenerationStore.getState().entries[id].saved).toBeUndefined();
  expect(usePanelTabStore.getState().sessions["workspace:wiki"].tabs[0].type).toBe("view-draft");
  await syncViewGeneration(context, { ...done, toolCallId: "historical-preview", output: preview }, open);
  expect(opened).toHaveLength(1);
  await syncViewGeneration(context, done, open);
  await syncViewGeneration(context, { ...done, output: preview }, open);
  expect(useViewGenerationStore.getState().entries[id].status).toBe("saved");
});


test("a saved destination is remembered when the preview transcript replays after reopening", async () => {
  await syncViewGeneration(context, pending, open);
  await syncViewGeneration(context, done, open);
  const outcome = viewToolOutcome(saved);
  if (!("view" in outcome)) throw new Error("Expected a saved view fixture");
  const view = outcome.view;
  // Save results contain only identity metadata, never programs or source data.
  useViewGenerationStore.getState().markSaved(id, view);
  expect(useViewGenerationStore.getState().savedResults[id]).not.toHaveProperty("program");
  expect(useViewGenerationStore.getState().savedResults[id]).not.toHaveProperty("datasets");
  useViewGenerationStore.setState({ entries: {} });
  const { version, title, mode, catalog, program, queries, owner } = saved;
  await syncViewGeneration(context, { ...done, output: { status: "preview", owner, input: { version, title, mode, catalog, program, queries } } }, open);
  expect(useViewGenerationStore.getState().entries[id].status).toBe("saved");
  expect(useViewGenerationStore.getState().entries[id].saved?.id).toBe(saved.id);
  expect(useViewGenerationStore.getState().entries[id].preview?.input.program).toBe(program);
  expect(opened).toHaveLength(1);
});

test("a completed unsaved preview is rebuilt from chat history after all window state is lost", async () => {
  const { version, title, mode, catalog, program, queries, owner } = saved;
  const preview = { status: "preview", owner, input: { version, title, mode, catalog, program, queries, datasets: { overview: { rows: [{ name: "Retained result" }], total: 1, revision: "snapshot", asOf: 1, truncated: false } } } };
  const part = parseDynamicToolUIPart({ type: "tool", id: "part", messageID: "message", sessionID: "session", callID: "call", tool: "view_create", state: { status: "completed", input: {}, output: JSON.stringify(preview), title, metadata: {}, time: { start: 1, end: 2 } } });
  if (!part) throw new Error("Expected a completed transcript tool part");
  await syncViewGeneration(context, pending, open);
  await syncViewGeneration(context, part, open);
  useViewGenerationStore.setState({ entries: {}, savedResults: {} });
  usePanelTabStore.setState({ sessions: {} });
  opened.length = 0;

  await reconcileViewGenerations(context, [part]);
  expect(useViewGenerationStore.getState().entries[id]).toMatchObject({ status: "preview", program, preview });
  expect(useViewGenerationStore.getState().savedResults).toEqual({});
  expect(opened).toHaveLength(0);
  const restored = useViewGenerationStore.getState().entries[id];
  open({ id, type: "view-draft", generationId: id, serverUrl: context.serverUrl, label: restored.title });
  expect(usePanelTabStore.getState().sessions["workspace:wiki"].tabs[0].type).toBe("view-draft");
});

test("large preview data is recovered from persisted tool metadata even if tool text is shortened", async () => {
  const { version, title, mode, catalog, program, queries, owner } = saved;
  const preview = { status: "preview", owner, input: { version, title, mode, catalog, program, queries, datasets: { large: { rows: [{ value: "x".repeat(60_000) }], total: 1, revision: "snapshot", asOf: 1, truncated: false } } } };
  const part = parseDynamicToolUIPart({ type: "tool", id: "part", messageID: "message", sessionID: "session", callID: "call", tool: "view_create", state: { status: "completed", input: {}, output: "Preview ready", title, metadata: { legalworkViewPreview: preview }, time: { start: 1, end: 2 } } });
  if (!part) throw new Error("Expected a completed transcript tool part");
  await reconcileViewGenerations(context, [part]);
  expect(useViewGenerationStore.getState().entries[id]).toMatchObject({ status: "preview", preview });
  expect(opened).toHaveLength(0);
});


test("deleting a chat removes its transient dashboard tabs but retains saved views", async () => {
  await syncViewGeneration(context, pending, open);
  const scope = "workspace:wiki";
  usePanelTabStore.getState().openTab(scope, { type: "view", id: "saved-view", serverUrl: "local", owner: { kind: "wiki", id: "wiki" }, viewId: saved.id, label: "Saved" });
  usePanelTabStore.getState().clearSession("session");
  expect(usePanelTabStore.getState().sessions[scope].tabs.map(tab => tab.type)).toEqual(["view"]);
  expect(useViewGenerationStore.getState().entries[id]).toBeUndefined();
});


test("Assistant generation records the preview without selecting or opening a tab", async () => {
  await syncViewGeneration({ ...context, autoOpen: false }, pending, open);
  await syncViewGeneration({ ...context, autoOpen: false }, done, open);
  expect(opened).toEqual([]);
  expect(useViewGenerationStore.getState().entries[id].status).toBe("saved");
  expect(usePanelTabStore.getState().sessions).toEqual({});
});

test("a chat preview edit streams into the original tab and survives transcript replay", async () => {
  const { version, title, mode, catalog, program, queries, owner } = saved;
  const preview = { status: "preview", owner, input: { version, title, mode, catalog, program, queries } };
  await syncViewGeneration(context, pending, open);
  await syncViewGeneration(context, { ...done, output: preview }, open);
  expect(visibleDashboardContext(context)).toContain('"preview_id":"call"');
  expect(visibleDashboardContext({ ...context, sessionId: "another-chat" })).toBe("");
  const edit = { ...pending, toolName: "view_update", toolCallId: "edit" };
  const editId = viewGenerationId("local", "session", "edit");
  await syncViewGeneration(context, edit, open);
  const rawInput = '{"preview_id":"call","program":"root = Text(\\"Rev';
  await syncViewGeneration(context, { ...edit, callProviderMetadata: { opencode: { rawInput } } }, open);
  const entries = () => useViewGenerationStore.getState().entries;
  expect(latestDraftId(id, entries())).toBe(editId);
  expect(entries()[editId]).toMatchObject({ program: 'root = Text("Rev', layoutEdit: true, title, status: "streaming" });
  expect(entries()[id].program).toBe(program);

  const revised = { ...preview, replacesCallId: "call", input: { ...preview.input, program: 'root = Text("Revised")' } };
  const result = { ...done, toolName: "view_update", toolCallId: "edit", output: revised };
  await syncViewGeneration(context, result, open);
  expect(opened.map(tab => tab.id)).toEqual([id]);
  expect(usePanelTabStore.getState().sessions["workspace:wiki"].tabs.map(tab => tab.id)).toEqual([id]);
  expect(visibleDashboardContext(context)).toContain('"preview_id":"edit"');
  useViewGenerationStore.setState({ entries: {} });
  await reconcileViewGenerations(context, [{ ...done, output: preview }, result]);
  expect(entries()[latestDraftId(id, entries())].preview).toMatchObject(revised);

  const failing = { ...edit, toolCallId: "attempt", input: { preview_id: "edit", program: "root = Text(" } };
  await syncViewGeneration(context, failing, open);
  await syncViewGeneration(context, { ...failing, state: "output-error", errorText: "Interrupted" }, open);
  expect(latestDraftId(id, entries())).toBe(editId);
  expect(opened).toHaveLength(1);
  await syncViewGeneration(context, { ...pending, toolCallId: "separate" }, open);
  expect(opened).toHaveLength(2);
});

test("a saved dashboard edit streams in its existing pane and restores the file on cancellation", async () => {
  const scope = "workspace:wiki";
  const tab = { type: "view", id: "saved-tab", serverUrl: context.serverUrl, owner: { kind: "wiki", id: "wiki" }, viewId: saved.id, label: "Live" } as const;
  usePanelTabStore.getState().openTab(scope, tab);
  const edit = { ...pending, toolName: "view_update", toolCallId: "edit-file", input: { view_id: saved.id, owner: tab.owner, base_revision: "r1", input: { program: 'root = Text("Revi' } } };
  await syncViewGeneration(context, edit, open);
  const panel = () => usePanelTabStore.getState().sessions[scope];
  expect(panel().tabs).toHaveLength(1);
  expect(panel().panes[0].activeTabId).toBe(viewGenerationId(context.serverUrl, context.sessionId, "edit-file"));
  await syncViewGeneration(context, { ...edit, state: "output-error", errorText: "Cancelled" }, open);
  expect(panel().tabs).toEqual([tab]);
  expect(panel().panes[0].activeTabId).toBe(tab.id);
});
