import { parseWikiPageUrl, wikiPageUrl } from "@legalwork/types/wiki";
import { deriveOpenTargets } from "../src/react-app/domains/session/artifacts/open-target";
import { beforeEach, describe, expect, test } from "bun:test";
import { viewPanelTab } from "../src/react-app/domains/views/view-reference";
import { wikiPanelTab, wikiTabForFileTarget } from "../src/react-app/domains/wiki/wiki-tabs";
import { resolveHrefOpenTarget } from "../src/react-app/domains/session/artifacts/open-target";
import { usePanelTabStore } from "../src/react-app/domains/session/panel/panel-tab-store";
import { restorePanelLayout, setFileSidebarState, setSidePanelState, useUiStateStore } from "../src/react-app/shell/ui-state-store";

beforeEach(() => usePanelTabStore.setState({ sessions: {}, transcriptArtifactTargets: {} }));

describe("Wiki navigation in the standard viewer", () => {
  test("source links open the owning wiki from a project and survive URL encoding", () => {
    const path = "Firm/People/Daniel Obi.md";
    const url = wikiPageUrl("wiki-1", path);
    const reference = parseWikiPageUrl(url);
    expect(reference).toEqual({ wikiId: "wiki-1", path });
    if (!reference) throw new Error("Expected wiki reference");
    const tab = wikiPanelTab("local", reference.wikiId, { kind: "page", path: reference.path }, "Daniel Obi");
    usePanelTabStore.getState().openTab("workspace:project", tab);
    expect(usePanelTabStore.getState().sessions["workspace:project"].tabs).toEqual([tab]);
    expect(deriveOpenTargets([{ id: "answer", role: "assistant", parts: [{ type: "text", text: `[Daniel Obi](${url})` }] }])).toEqual([]);
    expect(parseWikiPageUrl(wikiPageUrl("wiki-1", "People/Müller & Co. (EU).md"))?.path).toBe("People/Müller & Co. (EU).md");
    for (const invalid of ["legalwork-wiki://wiki-1/../secret.md", "legalwork-wiki://wiki-1/%2e%2e/secret.md", "legalwork-wiki://wiki-1//etc/file.md", "legalwork-wiki://wiki-1/a%00.md", "legalwork-wiki://wiki-1/a%ZZ.md"]) expect(parseWikiPageUrl(invalid)).toBeNull();
  });

  test("chat chips and the file tree open the same wiki page tab", () => {
    const wiki = { id: "firm", root: "/wikis/firm" };
    const path = "Clients/Belmont Ridge Bank National Association.md";
    const page = wikiPanelTab("local", wiki.id, { kind: "page", path }, "Belmont Ridge Bank National Association");
    const store = usePanelTabStore.getState();
    store.openTab("workspace:wiki", page);
    for (const href of [path.split("/").map(encodeURIComponent).join("/"), `file://${wiki.root}/${path.split("/").map(encodeURIComponent).join("/")}`]) {
      const target = resolveHrefOpenTarget(href, []);
      if (!target) throw new Error("Expected a file target");
      const tab = wikiTabForFileTarget("local", wiki, target);
      expect(tab).toEqual(page);
      if (tab) store.openTab("workspace:wiki", tab);
    }
    expect(usePanelTabStore.getState().sessions["workspace:wiki"].tabs).toEqual([page]);
  });

  test("wiki attachments keep their owner and unrelated files keep normal routing", () => {
    const wiki = { id: "firm", root: "/wikis/firm" };
    const target = resolveHrefOpenTarget("Templates/Engagement%20letter.docx", []);
    if (!target) throw new Error("Expected a file target");
    expect(wikiTabForFileTarget("local", wiki, target)).toEqual(wikiPanelTab("local", wiki.id, { kind: "asset", path: "Templates/Engagement letter.docx" }, "Engagement letter.docx"));
    for (const path of ["/wikis/other/Guide.md", "../other/Guide.md", "/wikis/firm-other/Guide.md", "/wikis/firm/../other/Guide.md", "C:/elsewhere/Guide.md"]) {
      expect(wikiTabForFileTarget("local", wiki, { ...target, value: path })).toBeNull();
    }
    expect(wikiTabForFileTarget("local", wiki, { ...target, value: "Views/overview.view.json", preview: "view" })).toBeNull();
    expect(wikiTabForFileTarget("local", wiki, { ...target, kind: "url", value: "https://example.com/Guide.md" })).toBeNull();
  });

  test("desktop restart reconnects known local wiki pages and views while preserving split panes", () => {
    const store = usePanelTabStore.getState();
    const old = "http://127.0.0.1:4001", current = "http://127.0.0.1:4002";
    const page = wikiPanelTab(old, "firm", { kind: "page", path: "Guide.md", mode: "source" }, "Guide");
    const view = viewPanelTab(old, { owner: { kind: "wiki", id: "firm" }, viewId: "31c119ce-672f-4e8b-a036-127609e3b56a" }, "Dashboard");
    const remote = wikiPanelTab("https://example.com", "firm", { kind: "graph" }, "Remote");
    const unknown = wikiPanelTab(old, "other", { kind: "graph" }, "Other");
    store.openTab("chat", page, "main");
    store.openTab("chat", remote, "main");
    store.openTab("chat", unknown, "main");
    store.openTab("chat", view, "main", "right");
    const before = usePanelTabStore.getState().sessions.chat;
    store.reconnectLocalTabs(current, ["firm"]);
    const after = usePanelTabStore.getState().sessions.chat;
    const nextPage = wikiPanelTab(current, "firm", page.location, page.label);
    const nextView = viewPanelTab(current, view, view.label);
    expect(after.tabs).toEqual([nextPage, remote, unknown, nextView]);
    expect(after.tree).toEqual(before.tree);
    expect(after.focusedPaneId).toBe(before.focusedPaneId);
    expect(after.panes.find(pane => pane.id === after.focusedPaneId)?.activeTabId).toBe(nextView.id);
    expect(after.panes.some(pane => pane.tabIds.includes(page.id) || pane.tabIds.includes(view.id))).toBe(false);
    store.reconnectLocalTabs(current, ["firm"]);
    expect(usePanelTabStore.getState().sessions.chat).toBe(after);
  });
  test("restoring a workspace drops retired YAML view tabs without losing pages, graphs or saved dashboards", () => {
    const store = usePanelTabStore.getState();
    const tabs = [
      wikiPanelTab("local", "firm", { kind: "page", path: "Guide.md" }, "Guide"),
      wikiPanelTab("local", "firm", { kind: "graph" }, "Graph"),
      viewPanelTab("local", { owner: { kind: "wiki", id: "firm" }, viewId: "31c119ce-672f-4e8b-a036-127609e3b56a" }, "Dashboard"),
    ];
    for (const tab of tabs) store.openTab("chat", tab);
    const saved = usePanelTabStore.getState().sessions.chat;
    const legacy = { id: "retired", type: "wiki", label: "Processes", serverUrl: "local", wikiId: "firm", location: { kind: "view", name: "Processes" } };
    const restored = store.readLayout({ ...saved, tabs: [...tabs, legacy], panes: saved.panes.map(pane => ({ ...pane, tabIds: [...pane.tabIds, legacy.id], activeTabId: legacy.id })) });
    expect(restored?.tabs).toEqual(tabs);
    expect(restored?.panes.some(pane => pane.tabIds.includes(legacy.id) || pane.activeTabId === legacy.id)).toBe(false);
  });
  test("attachments retain original wiki identity through restore and folder moves", () => {
    const store = usePanelTabStore.getState();
    const asset = wikiPanelTab("local", "firm", { kind: "asset", path: "Attachments/Contract.docx" }, "Contract.docx");
    const samePathOtherWiki = wikiPanelTab("local", "other", { kind: "asset", path: "Attachments/Contract.docx" }, "Contract.docx");
    store.openTab("workspace:project", asset);
    store.openTab("workspace:project", samePathOtherWiki);
    const saved = usePanelTabStore.getState().sessions["workspace:project"];
    expect(store.readLayout(JSON.parse(JSON.stringify(saved)))?.tabs).toEqual([asset, samePathOtherWiki]);
    store.updateWikiPaths("local", "firm", "Attachments", "Files");
    expect(usePanelTabStore.getState().sessions["workspace:project"].tabs).toEqual([
      wikiPanelTab("local", "firm", { kind: "asset", path: "Files/Contract.docx" }, "Contract.docx"), samePathOtherWiki,
    ]);
    store.updateWikiPaths("local", "firm", "Files", null);
    expect(usePanelTabStore.getState().sessions["workspace:project"].tabs).toEqual([samePathOtherWiki]);
  });
  test("renaming a wiki page preserves its split pane and trash leaves unrelated panes intact", () => {
    const store = usePanelTabStore.getState();
    const scope = "workspace:wiki-layout";
    const other = wikiPanelTab("local", "other", { kind: "page", path: "Guide.md" }, "Other guide");
    const page = wikiPanelTab("local", "firm", { kind: "page", path: "Old/Guide.md" }, "Guide");
    store.openTab(scope, other, "main");
    store.openTab(scope, page, "main", "right");
    const before = usePanelTabStore.getState().sessions[scope];
    const wikiPane = before.panes.find(pane => pane.tabIds.includes(page.id));
    expect(before.panes).toHaveLength(2);
    expect(wikiPane?.activeTabId).toBe(page.id);

    store.updateWikiPaths("local", "firm", "Old", "New");
    const moved = wikiPanelTab("local", "firm", { kind: "page", path: "New/Guide.md" }, "Guide");
    const after = usePanelTabStore.getState().sessions[scope];
    expect(after.tree).toEqual(before.tree);
    expect(after.sizes).toEqual(before.sizes);
    expect(after.focusedPaneId).toBe(before.focusedPaneId);
    expect(after.panes.find(pane => pane.id === wikiPane?.id)).toEqual({ ...wikiPane, tabIds: [moved.id], activeTabId: moved.id });
    expect(after.panes.find(pane => pane.id === "main")).toEqual(before.panes.find(pane => pane.id === "main"));

    store.updateWikiPaths("local", "firm", "New", null);
    const remaining = usePanelTabStore.getState().sessions[scope];
    expect(remaining.tabs).toEqual([other]);
    expect(remaining.panes).toHaveLength(1);
    expect(remaining.panes[0].tabIds).toEqual([other.id]);
    expect(remaining.tree).toEqual({ type: "pane", id: "main" });
  });
  test("moving a folder updates open wiki tabs across chats and trash closes only its pages", () => {
    const store = usePanelTabStore.getState();
    const page = wikiPanelTab("local", "firm", { kind: "page", path: "Old/Guide.md", anchor: "sources", mode: "source" }, "Guide");
    const otherWiki = wikiPanelTab("local", "other", { kind: "page", path: "Old/Guide.md" }, "Guide");
    store.openTab("one", page);
    store.openTab("two", page);
    store.openTab("two", otherWiki);
    store.updateWikiPaths("local", "firm", "Old", "New");
    const moved = wikiPanelTab("local", "firm", { kind: "page", path: "New/Guide.md", anchor: "sources", mode: "source" }, "Guide");
    expect(usePanelTabStore.getState().sessions.one.tabs).toEqual([moved]);
    expect(usePanelTabStore.getState().sessions.one.activeTabId).toBe(moved.id);
    expect(usePanelTabStore.getState().sessions.two.tabs).toEqual([moved, otherWiki]);
    expect(usePanelTabStore.getState().sessions.two.activeTabId).toBe(otherWiki.id);
    store.updateWikiPaths("local", "firm", "New", null);
    expect(usePanelTabStore.getState().sessions.one.tabs).toEqual([]);
    expect(usePanelTabStore.getState().sessions.two.tabs).toEqual([otherWiki]);
  });
  test("opening the folder browser does not open a viewer and survives viewer switches", () => {
    const initial = { ...useUiStateStore.getState(), sidePanelState: {}, fileSidebarState: {} };
    const browsing = setFileSidebarState(initial, "chat", "wiki");
    expect(browsing.sidePanelState.chat).toBeUndefined();
    const previewing = setSidePanelState(browsing, "chat", "panel");
    expect(previewing.fileSidebarState.chat).toBe("wiki");
    const closed = setSidePanelState(previewing, "chat", null);
    expect(closed.fileSidebarState.chat).toBe("wiki");
    expect(restorePanelLayout(JSON.parse(JSON.stringify(closed)))).toEqual({ sidePanelState: { chat: null }, fileSidebarState: { chat: "wiki" } });
  });

  test("page links reuse the open tab and update its section while other tabs stay open", () => {
    const store = usePanelTabStore.getState();
    const page = wikiPanelTab("local", "firm", { kind: "page", path: "Processes/Review.md" }, "Review");
    store.openTab("chat", { id: "contract", type: "artifact", label: "Contract", value: "Contract.md", preview: "markdown" });
    store.openTab("chat", page);
    store.openTab("chat", viewPanelTab("local", { owner: { kind: "wiki", id: "firm" }, viewId: "31c119ce-672f-4e8b-a036-127609e3b56a" }, "Processes"));
    const section = wikiPanelTab("local", "firm", { kind: "page", path: "Processes/Review.md", anchor: "sources" }, "Review");
    store.openTab("chat", section);
    const panel = usePanelTabStore.getState().sessions.chat;
    expect(panel.tabs).toHaveLength(3);
    expect(panel.activeTabId).toBe(page.id);
    expect(panel.tabs.find((tab) => tab.id === page.id)).toEqual(section);
    store.syncArtifactTargets("chat", []);
    expect(usePanelTabStore.getState().sessions.chat.tabs).toHaveLength(3);
  });

  test("the same path across wikis or servers and different view kinds get separate tabs", () => {
    const store = usePanelTabStore.getState();
    const tabs = [
      wikiPanelTab("local", "one", { kind: "page", path: "Guide.md" }, "Guide"),
      wikiPanelTab("local", "two", { kind: "page", path: "Guide.md" }, "Guide"),
      wikiPanelTab("remote", "one", { kind: "page", path: "Guide.md" }, "Guide"),
      viewPanelTab("local", { owner: { kind: "wiki", id: "one" }, viewId: "31c119ce-672f-4e8b-a036-127609e3b56a" }, "Guide"),
      wikiPanelTab("local", "one", { kind: "graph" }, "Graph"),
    ];
    for (const tab of tabs) store.openTab("chat", tab);
    expect(usePanelTabStore.getState().sessions.chat.tabs).toEqual(tabs);
    store.reorderTabs("chat", tabs.map((tab) => tab.id).reverse());
    expect(usePanelTabStore.getState().sessions.chat.tabs).toEqual([...tabs].reverse());
    store.closeTab("chat", tabs[4].id);
    expect(usePanelTabStore.getState().sessions.chat.activeTabId).toBe(tabs[3].id);
    store.selectTab("chat", tabs[0].id);
    expect(usePanelTabStore.getState().sessions.chat.activeTabId).toBe(tabs[0].id);
  });
});
