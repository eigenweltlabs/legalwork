import { expect, test } from "bun:test";
import { openBackgroundTab, paneRightOfChat } from "../src/react-app/domains/session/background/open-background-tab";
import { usePanelTabStore } from "../src/react-app/domains/session/panel/panel-tab-store";

test("promotion uses the owning chat's local project and always opens beside it", () => {
  const scope = "workspace:mini-promotion-test";
  const store = usePanelTabStore.getState();
  store.adoptChat(scope, "mini-task", "Task");
  const chat = usePanelTabStore.getState().sessions[scope].panes[0].id;
  const file = { id: "file:mini.md", type: "artifact", label: "Mini", value: "mini.md", preview: "markdown" } satisfies Parameters<typeof openBackgroundTab>[2];
  try {
    openBackgroundTab("workspace:server-id", "mini-task", file);
    let state = usePanelTabStore.getState().sessions[scope];
    expect(state.panes).toHaveLength(2);
    const right = paneRightOfChat(state.tree, chat);
    expect(right).toBeDefined();
    expect(state.panes.find(pane => pane.id === chat)?.tabIds).toEqual(["chat:mini-task"]);
    expect(state.panes.find(pane => pane.id === right)?.tabIds).toEqual([file.id]);
    expect(usePanelTabStore.getState().sessions["workspace:server-id"]).toBeUndefined();
    openBackgroundTab(scope, "mini-task", { ...file, id: "file:second.md", value: "second.md" });
    state = usePanelTabStore.getState().sessions[scope];
    expect(state.panes).toHaveLength(2);
    expect(state.panes.find(pane => pane.id === right)?.tabIds).toEqual([file.id, "file:second.md"]);
  } finally {
    const { [scope]: removed, ...sessions } = usePanelTabStore.getState().sessions;
    usePanelTabStore.setState({ sessions });
  }
});

test("a website popup joins its opener's pane even after that browser moves away from the chat", () => {
  const scope = "workspace:popup-promotion-test", selected: string[] = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    __LEGALWORK_ELECTRON__: { browser: { selectTab: async (id: string) => { selected.push(id); } } },
  } });
  const browser = (id: string) => ({ id, type: "browser", label: "Fixture", background: false,
    url: "https://fixture.test", favicon: null, status: "ready", canGoBack: false, canGoForward: false } satisfies Parameters<typeof openBackgroundTab>[2]);
  try {
    const store = usePanelTabStore.getState();
    store.adoptChat(scope, "popup-chat", "Task");
    const chatPane = usePanelTabStore.getState().sessions[scope].panes[0].id;
    openBackgroundTab(scope, "popup-chat", browser("parent"));
    store.moveTab(scope, "parent", chatPane, "left");
    const before = usePanelTabStore.getState().sessions[scope];
    const opener = before.panes.find(pane => pane.tabIds.includes("parent"));
    expect(opener).toBeDefined();
    openBackgroundTab("workspace:server-id", "popup-chat", browser("child"), "parent");
    const after = usePanelTabStore.getState().sessions[scope];
    expect(after.panes).toHaveLength(before.panes.length);
    expect(after.panes.find(pane => pane.id === opener?.id)?.tabIds).toEqual(["parent", "child"]);
    expect(after.panes.find(pane => pane.id === opener?.id)?.activeTabId).toBe("child");
    expect(selected.at(-1)).toBe("child");
  } finally {
    const { [scope]: removed, ...sessions } = usePanelTabStore.getState().sessions;
    usePanelTabStore.setState({ sessions });
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
