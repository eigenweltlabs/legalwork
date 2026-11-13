import { expect, test } from "bun:test";
import type { BrowserPanelTab } from "../src/app/lib/desktop-types";
import { assistantBrowserWorkerIds, visibleTaskBrowserTabs } from "../src/react-app/domains/session/background/task-browser-tabs";
import { openBackgroundTab } from "../src/react-app/domains/session/background/open-background-tab";
import { usePanelTabStore } from "../src/react-app/domains/session/panel/panel-tab-store";

const browser = (taskSessionId: string): BrowserPanelTab => ({ id: `tab:${taskSessionId}`, type: "browser", taskSessionId, workspaceId: "assistant", background: true, label: "Website", url: "https://example.org", favicon: null, status: "ready", canGoBack: false, canGoForward: false });
const sessions = { parent: { id: "parent", title: "Assistant" }, worker: { id: "worker", parentID: "parent", title: "Browser" }, grandchild: { id: "grandchild", parentID: "worker", title: "Child" }, unrelated: { id: "unrelated", title: "Other chat" } };

test("Assistant browser tiles include known descendants without including unrelated chats", () => {
  const tabs = [browser("parent"), browser("worker"), browser("grandchild"), browser("unrelated"), browser("unknown")];
  expect(visibleTaskBrowserTabs(tabs, "parent", true, sessions).map(tab => tab.taskSessionId)).toEqual(["parent", "worker", "grandchild"]);
  expect(visibleTaskBrowserTabs(tabs, "parent", false, sessions).map(tab => tab.taskSessionId)).toEqual(["parent"]);
  expect(visibleTaskBrowserTabs([{ ...browser("worker"), workspaceId: "native-workspace-alias" }], "parent", true, sessions)).toHaveLength(1);
  expect(visibleTaskBrowserTabs([{ ...browser("worker"), dismissed: true }, { ...browser("worker"), background: false }], "parent", true, sessions)).toEqual([]);
});

test("the main Assistant discovers unopened workers from other daily contexts without opening their chats", async () => {
  const panelBefore = usePanelTabStore.getState().sessions;
  const owners = ["today-worker", "yesterday-worker", "nested-worker", "other-project", "ordinary-chat", "deleted"];
  const workers = await assistantBrowserWorkerIds(async id => {
    if (id === "deleted") throw new Error("Not found");
    return {
      location: { directory: id === "other-project" ? "/another-project" : "/Assistant" },
      parentID: id.endsWith("worker") ? "another-assistant-context" : id === "other-project" ? "another-parent" : undefined,
    };
  }, "today", owners);
  expect(workers).toEqual(["today-worker", "yesterday-worker", "nested-worker"]);
  expect(visibleTaskBrowserTabs(owners.map(browser), "today", true, {}, workers).map(tab => tab.taskSessionId)).toEqual(workers);
  expect(visibleTaskBrowserTabs(owners.map(browser), "today", false, {}, workers)).toEqual([]);
  expect(usePanelTabStore.getState().sessions).toBe(panelBefore);
});

test("Assistant worker previews disappear on completion or failure, but remain during work and approval waits", () => {
  const tabs = [browser("worker"), { ...browser("worker"), id: "second-worker-tab" }, browser("grandchild"), browser("parent")];
  for (const status of ["thinking", "responding", "compacting", "waiting"] satisfies import("../src/react-app/domains/session/status/session-activity-store").SessionActivityStatus[]) {
    expect(visibleTaskBrowserTabs(tabs, "parent", true, sessions, [], { worker: status })).toEqual(tabs);
  }
  // Missing status during a refresh is not proof that the worker finished.
  expect(visibleTaskBrowserTabs(tabs, "parent", true, sessions)).toEqual(tabs);
  for (const status of ["idle", "error"] satisfies import("../src/react-app/domains/session/status/session-activity-store").SessionActivityStatus[]) {
    expect(visibleTaskBrowserTabs(tabs, "parent", true, sessions, [], { worker: status }).map(tab => tab.taskSessionId)).toEqual(["grandchild", "parent"]);
    expect(visibleTaskBrowserTabs([browser("older-worker")], "parent", true, {}, ["older-worker"], { "older-worker": status })).toEqual([]);
  }
  // A resumed worker becomes visible again. Its native tabs are never mutated.
  expect(visibleTaskBrowserTabs(tabs, "parent", true, sessions, [], { worker: "thinking" })).toEqual(tabs);
  expect(tabs.every(tab => tab.background && !tab.dismissed)).toBe(true);
  expect(visibleTaskBrowserTabs([browser("parent")], "parent", false, sessions, [], { parent: "idle" })).toHaveLength(1);
});

test("opening a child browser tile keeps its actual browser and worker ownership beside the parent", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const opened: string[] = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: { __LEGALWORK_ELECTRON__: { browser: { selectTab: async (id: string) => { opened.push(id); } } } } });
  const scope = "workspace:assistant-browser-test";
  usePanelTabStore.getState().adoptChat(scope, "parent", "Assistant");
  try {
    const tab = { ...browser("worker"), background: false };
    openBackgroundTab(scope, "parent", tab);
    const panel = usePanelTabStore.getState().sessions[scope];
    expect(panel.tabs.find(item => item.id === tab.id)).toMatchObject({ id: "tab:worker", taskSessionId: "worker", background: false });
    expect(panel.panes).toHaveLength(2);
    expect(panel.tabs.filter(item => item.type === "chat").map(item => item.id)).toEqual(["chat:parent"]);
    expect(opened).toEqual(["tab:worker"]);
  } finally {
    const { [scope]: removed, ...rest } = usePanelTabStore.getState().sessions;
    usePanelTabStore.setState({ sessions: rest });
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window");
  }
});
