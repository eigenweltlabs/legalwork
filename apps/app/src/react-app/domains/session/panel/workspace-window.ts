import { desktopBridge } from "@/app/lib/desktop";
import { getElectronBrowser } from "./utils";
import { usePanelTabStore, workspacePanelKey, normalizeSession, type PanelTab, type SessionPanelState } from "./panel-tab-store";

const PREFIX = "legalwork:window-seed:";
/** Only navigation is copied. Editors, undo stacks and composer drafts remain
 * private to their window; documents acquire their usual single-writer lock. */
export async function openWorkspaceWindow(workspaceId: string, selected?: PanelTab) {
  if (selected?.type === "workflow" || selected?.type === "workflow-resource") {
    await desktopBridge.openAppWindow({ page: "workflows" }); return;
  }
  const store = usePanelTabStore.getState();
  const state = store.sessions[workspacePanelKey(workspaceId)];
  if (!state) return;
  const tabs = (selected ? [selected] : state.tabs).filter(tab => tab.type !== "workflow" && tab.type !== "workflow-resource").map(tab => {
    if (tab.type !== "artifact" || tab.value) return tab;
    const value = store.transcriptArtifactTargets[tab.sourceSessionId ?? ""]?.find(target => target.id === tab.id)?.value;
    return { ...tab, value };
  });
  const layout = normalizeSession(selected ? { ...state, tabs, panes: [{ id: "main", tabIds: tabs.map(tab => tab.id), activeTabId: selected.id }], tree: { type: "pane", id: "main" }, sizes: {}, focusedPaneId: "main" } : { ...state, tabs });
  const seed = crypto.randomUUID();
  // Short-lived, same-origin transfer. The route exposes only a random token.
  localStorage.setItem(PREFIX + seed, JSON.stringify({ workspaceId, layout, created: Date.now() }));
  try { await desktopBridge.openProjectWindow({ workspaceId, page: "workspace", seed, title: selected?.label }); }
  catch (error) { localStorage.removeItem(PREFIX + seed); throw error; }
  setTimeout(() => localStorage.removeItem(PREFIX + seed), 60_000);
}

let restoring: Promise<void> | null = null;
export async function restoreWorkspaceWindow(workspaceId: string) {
  if (restoring) return restoring;
  const search = new URLSearchParams(location.hash.includes("?") ? location.hash.slice(location.hash.indexOf("?")) : location.search);
  const seed = search.get("seed");
  if (!seed || !/^[\w-]+$/.test(seed)) return Promise.resolve();
  const raw = localStorage.getItem(PREFIX + seed);
  if (!raw) return Promise.resolve();
  const input: unknown = JSON.parse(raw);
  if (!input || typeof input !== "object" || !("workspaceId" in input) || input.workspaceId !== workspaceId || !("created" in input) || typeof input.created !== "number" || Date.now() - input.created > 60_000 || !("layout" in input)) return Promise.resolve();
  // The producer and consumer are this app. Hydration below still validates the
  // serialized union and layout before any file or chat is opened.
  const layout = usePanelTabStore.getState().readLayout(input.layout);
  if (!layout) return Promise.resolve();
  localStorage.removeItem(PREFIX + seed);
  restoring = (async () => {
    const browser = getElectronBrowser();
    const replacements = new Map<string, string>();
    const tabs: PanelTab[] = [];
    for (const tab of layout.tabs) {
      if (tab.type !== "browser") { tabs.push(tab); continue; }
      const result = await browser?.createTab?.(tab.url || undefined);
      if (!result) continue;
      replacements.set(tab.id, result.tabId);
      tabs.push({ ...tab, id: result.tabId });
    }
    const id = (value: string | null) => value ? replacements.get(value) ?? value : null;
    const next: SessionPanelState = normalizeSession({ ...layout, tabs, panes: layout.panes.map(pane => ({ ...pane, tabIds: pane.tabIds.map(value => replacements.get(value) ?? value), activeTabId: id(pane.activeTabId) })) });
    usePanelTabStore.setState(state => ({ sessions: { ...state.sessions, [workspacePanelKey(workspaceId)]: next } }));
  })();
  return restoring;
}
