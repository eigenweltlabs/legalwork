import { describe, expect, test } from "bun:test";
import { chatPanelTab, createPanelTabStore, workspacePanelKey, type ArtifactPanelTab, type SessionPanelState } from "../src/react-app/domains/session/panel/panel-tab-store";

const scope = workspacePanelKey("assistant");
const file: ArtifactPanelTab = { id: "file:brief", type: "artifact", label: "Brief", value: "brief.md", preview: "markdown" };

function createStore() {
  const storage = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  } });
  const panels = createPanelTabStore();
  if (previous) Object.defineProperty(globalThis, "localStorage", previous);
  else Reflect.deleteProperty(globalThis, "localStorage");
  panels.setState({ sessions: {}, opening: {}, transcriptArtifactTargets: {} });
  return panels;
}

function duplicateLayout(): SessionPanelState {
  return {
    tabs: [chatPanelTab("yesterday", "Assistant"), file, chatPanelTab("today", "Assistant")],
    panes: [
      { id: "chat", tabIds: ["chat:yesterday"], activeTabId: "chat:yesterday" },
      { id: "document", tabIds: [file.id, "chat:today"], activeTabId: file.id },
    ],
    tree: { type: "split", id: "columns", direction: "horizontal", first: { type: "pane", id: "chat" }, second: { type: "pane", id: "document" } },
    sizes: { columns: { chat: 40, document: 60 } },
    focusedPaneId: "document", activeTabId: "chat:yesterday", sideTabIds: [file.id, "chat:today"], sideActiveTabId: file.id,
  };
}

describe("one Assistant conversation tab", () => {
  test("day changes and repeated opens reuse its group while preserving documents and widths", () => {
    const panels = createStore();
    const store = panels.getState();
    store.setAssistantWorkspace("assistant");
    store.adoptChat(scope, "yesterday", "Assistant");
    store.openTab(scope, file, "main", "right");
    const before = panels.getState().sessions[scope];
    store.adoptChat(scope, "today", "Johannes");
    store.adoptChat(scope, "today", "Johannes");
    const after = panels.getState().sessions[scope];
    expect(after.tabs).toEqual([chatPanelTab("today", "Johannes"), file]);
    expect(after.tree).toEqual(before.tree);
    expect(after.sizes).toEqual(before.sizes);
    expect(after.panes[0].tabIds).toEqual(["chat:today"]);
    expect(after.panes[1]).toEqual(before.panes[1]);
  });

  test("history and split drops update the same chat instead of creating a second group", () => {
    const panels = createStore();
    const store = panels.getState();
    store.setAssistantWorkspace("assistant");
    store.adoptChat(scope, "today", "Assistant");
    store.openTab(scope, file, "main", "right");
    const documentPane = panels.getState().sessions[scope].panes[1].id;
    store.restoreNavigationTab(scope, chatPanelTab("yesterday", "Assistant"), documentPane);
    store.openTab(scope, chatPanelTab("earlier", "Assistant"), documentPane, "bottom");
    const after = panels.getState().sessions[scope];
    expect(after.tabs.filter(tab => tab.type === "chat")).toEqual([chatPanelTab("earlier", "Assistant")]);
    expect(after.panes).toHaveLength(2);
    expect(after.panes[0].tabIds).toEqual(["chat:earlier"]);
    expect(after.panes[1].tabIds).toEqual([file.id]);
  });

  test("registering a previously stored workspace removes duplicates without touching transcript data or document panes", () => {
    const panels = createStore();
    const before = duplicateLayout();
    panels.setState({ sessions: { [scope]: before, "unrelated-session": duplicateLayout() } });
    panels.getState().setAssistantWorkspace("assistant");
    const after = panels.getState().sessions[scope];
    expect(after.tabs).toEqual([chatPanelTab("yesterday", "Assistant"), file]);
    expect(after.tree).toEqual(before.tree);
    expect(after.sizes).toEqual(before.sizes);
    expect(after.panes[1]).toMatchObject({ id: "document", tabIds: [file.id], activeTabId: file.id });
    expect(after.focusedPaneId).toBe("document");
    expect(panels.getState().sessions["unrelated-session"]).toEqual(duplicateLayout());
  });

  test("hydrated Assistant layouts keep the focused chat and prune empty duplicate groups", async () => {
    const panels = createStore();
    const layout = duplicateLayout();
    const restored = panels.getState().readLayout({ ...layout, assistant: true, focusedPaneId: "document", panes: [layout.panes[0], { ...layout.panes[1], activeTabId: "chat:today" }] });
    expect(restored?.tabs).toEqual([file, chatPanelTab("today", "Assistant")]);
    expect(restored?.panes).toHaveLength(1);
    expect(restored?.panes[0].id).toBe("document");
    panels.setState({ sessions: restored ? { [scope]: restored } : {} });
    await panels.persist.rehydrate();
    panels.getState().openTab(scope, chatPanelTab("tomorrow", "Assistant"));
    expect(panels.getState().sessions[scope].assistant).toBe(true);
    expect(panels.getState().sessions[scope].tabs.filter(tab => tab.type === "chat")).toEqual([chatPanelTab("tomorrow", "Assistant")]);
  });

  test("legacy layout migrations preserve the Assistant invariant", () => {
    const panels = createStore();
    panels.getState().setAssistantWorkspace("assistant");
    panels.setState(state => ({ sessions: { ...state.sessions, "project:assistant": duplicateLayout() } }));
    panels.getState().migrateWorkspace("assistant");
    panels.getState().adoptChat(scope, "current", "Assistant");
    expect(panels.getState().sessions[scope].assistant).toBe(true);
    expect(panels.getState().sessions[scope].tabs).toEqual([chatPanelTab("current", "Assistant"), file]);
    expect(panels.getState().sessions["project:assistant"]).toBeUndefined();
  });

  test("subagents open beside the Assistant and survive day changes while only daily chats are replaced", () => {
    const panels = createStore();
    const store = panels.getState();
    store.setAssistantWorkspace("assistant");
    store.adoptChat(scope, "today", "Johannes");
    const child = chatPanelTab("research", "Research", "today");
    store.adoptChat(scope, child.sessionId, child.label, { parentID: child.parentID });
    store.openTab(scope, child, "main", "right");
    store.openTab(scope, chatPanelTab("nested", "Verify sources", "research"));
    const before = panels.getState().sessions[scope];
    expect(before.tabs).toEqual([chatPanelTab("today", "Johannes"), child, chatPanelTab("nested", "Verify sources", "research")]);
    expect(before.panes).toHaveLength(2);
    // Reopening a child through an older link must not lose its identity.
    store.openTab(scope, chatPanelTab("research", "Research"));
    store.adoptChat(scope, "tomorrow", "Renamed assistant");
    const after = panels.getState().sessions[scope];
    expect(after.tabs).toEqual([chatPanelTab("tomorrow", "Renamed assistant"), child, chatPanelTab("nested", "Verify sources", "research")]);
    expect(after.tree).toEqual(before.tree);
    expect(after.panes[1].tabIds).toEqual(before.panes[1].tabIds);
  });

  test("restore, history and normalization retain child tabs alongside one daily Assistant", async () => {
    const panels = createStore();
    const store = panels.getState();
    store.setAssistantWorkspace("assistant");
    store.adoptChat(scope, "today", "Johannes");
    const child = chatPanelTab("research", "Research", "today");
    store.openTab(scope, child, "main", "right");
    store.openTab(scope, file);
    const restored = store.readLayout(panels.getState().sessions[scope]);
    expect(restored?.tabs).toContainEqual(child);
    panels.setState({ sessions: restored ? { [scope]: restored } : {} });
    await panels.persist.rehydrate();
    store.restoreNavigationTab(scope, child, "main");
    store.setAssistantWorkspace("assistant");
    store.openTab(scope, chatPanelTab("yesterday", "Johannes"), "main", "bottom");
    const after = panels.getState().sessions[scope];
    expect(after.tabs).toEqual([chatPanelTab("yesterday", "Johannes"), child, file]);
    expect(after.tabs.filter(tab => tab.type === "chat" && !tab.parentID)).toHaveLength(1);
  });

  test("normal projects still support several chats and split groups", () => {
    const panels = createStore();
    const project = workspacePanelKey("project");
    panels.getState().adoptChat(project, "one", "One");
    panels.getState().openTab(project, chatPanelTab("two", "Two"), "main", "right");
    expect(panels.getState().sessions[project].tabs).toHaveLength(2);
    expect(panels.getState().sessions[project].panes).toHaveLength(2);
  });
});
