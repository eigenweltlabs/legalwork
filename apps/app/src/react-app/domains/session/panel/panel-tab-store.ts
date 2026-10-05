import type { SearchSourceReference } from "@legalwork/types/search";
import { create } from "zustand";
import type { ReviewSourceReference } from "@legalwork/types/reviews";
import { confirmDiscardSessionDocuments } from "../artifacts/docx-document-state";
import { createJSONStorage, persist } from "zustand/middleware";

import { classifyOpenTarget, isCollectibleArtifactTarget, type OpenTarget, type OpenTargetPreview } from "../artifacts/open-target";
import type { StorageFileSource } from "./storage-file-tab";

export const PERSISTED_PANEL_TAB_STORE_KEY = "legalwork:panel-tabs:v1";

/**
 * Synthetic session key for the right panel on top-level mainView pages
 * (Evals / Benchmark): artifact tabs opened outside a chat session live here.
 */
export const EVALS_PANEL_SESSION_ID = "__evals__";

// Asking for a tab lives in its own module, so asking does not create this store.
export { PANEL_OPEN_TAB_EVENT, requestPanelTab } from "./panel-tab-request";

export type PanelTabType = "artifact" | "browser" | "task" | "workflow" | "workflow-resource";

export type { BrowserPanelTab } from "../../../../app/lib/desktop-types";
import type { BrowserPanelTab } from "../../../../app/lib/desktop-types";

export type ArtifactPanelTab = {
  id: string;
  type: "artifact";
  label: string;
  preview: OpenTargetPreview;
  // Workspace-relative path for tabs opened directly from the workspace file
  // browser. Tabs without it resolve through the session's transcript targets.
  value?: string;
  size?: number;
  updatedAt?: number;
  storage?: StorageFileSource;
  sourcePage?: number;
  searchSources?: SearchSourceReference[];
  reviewCitation?: ReviewSourceReference;
  /** A review document's recognized pages; without a page, the first page that needs review. */
  reviewRecognition?: { reviewId: string; documentId: string; page?: number };
}

export type TaskPanelTab = {
  id: string;
  type: "task";
  taskId: string;
  label: string;
};

export type WorkflowPanelTab = { id: string; type: "workflow"; label: string };
export type WorkflowResourcePanelTab = { id: string; type: "workflow-resource"; label: string };

export type PanelTab = BrowserPanelTab | ArtifactPanelTab | TaskPanelTab | WorkflowPanelTab | WorkflowResourcePanelTab;

export type DocumentLayout = "single" | "columns" | "rows" | "three-columns" | "main-and-stack";
export type DocumentPaneState = { id: string; tabIds: string[]; activeTabId: string | null };
export type SessionPanelState = {
  tabs: PanelTab[];
  panes: DocumentPaneState[];
  layout: DocumentLayout;
  sizes: Record<string, Record<string, number>>;
  // Compatibility for browser integration and previously persisted two-pane state.
  activeTabId: string | null;
  sideTabIds: string[];
  sideActiveTabId: string | null;
};
export const DOCUMENT_LAYOUTS: DocumentLayout[] = ["single", "columns", "rows", "three-columns", "main-and-stack"];
export function layoutPaneCount(layout: DocumentLayout) { return layout === "single" ? 1 : layout === "columns" || layout === "rows" ? 2 : 3; }

type PersistedPanelTab = { id: string; type: "browser" } | { id: string; type: "artifact"; label: string; value: string };
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function restoredTab(value: unknown): PanelTab | null {
  if (!record(value) || typeof value.id !== "string") return null;
  if (value.type === "artifact" && typeof value.label === "string" && typeof value.value === "string" && value.value)
    return { id: value.id, type: "artifact", label: value.label, value: value.value, preview: classifyOpenTarget(value.value, "file") };
  if (value.type !== "browser") return null;
  return { id: value.id, type: "browser", label: "New tab", url: "", favicon: null, status: "ready", canGoBack: false, canGoForward: false };
}

export type PanelTabStore = {
  sessions: Record<string, SessionPanelState>;
  transcriptArtifactTargets: Record<string, OpenTarget[]>;
  openTab: (sessionId: string, tab: PanelTab, pane?: string) => void;
  setStorageWorkingPath: (sessionId: string, tabId: string, path: string) => void;
  closeTab: (sessionId: string, tabId: string) => void;
  selectTab: (sessionId: string, tabId: string) => void;
  moveTab: (sessionId: string, tabId: string, pane: string) => void;
  setLayout: (sessionId: string, layout: DocumentLayout) => void;
  setPaneSizes: (sessionId: string, layout: string, sizes: Record<string, number>) => void;
  moveTabToSide: (sessionId: string, tabId: string) => void;
  moveTabToMain: (sessionId: string, tabId: string) => void;
  // Accepts the order of one pane; tabs of the other pane keep their places.
  reorderTabs: (sessionId: string, tabIds: string[]) => void;
  syncBrowserTabs: (sessionId: string, browserTabs: BrowserPanelTab[], activeBrowserTabId: string | null) => void;
  syncArtifactTargets: (
    sessionId: string,
    targets: Array<{ id: string; name: string; preview: OpenTargetPreview }>,
  ) => void;
  syncTranscriptArtifacts: (sessionId: string, targets: OpenTarget[]) => void;
  clearSession: (sessionId: string) => void;
};

const EMPTY_SESSION: SessionPanelState = {
  tabs: [], panes: [{ id: "main", tabIds: [], activeTabId: null }], layout: "single", sizes: {},
  activeTabId: null, sideTabIds: [], sideActiveTabId: null,
};

function getWritableSession(state: PanelTabStore, sessionId: string): SessionPanelState {
  return state.sessions[sessionId] ?? EMPTY_SESSION;
}
function updateSession(state: PanelTabStore, sessionId: string, session: SessionPanelState): Partial<PanelTabStore> {
  return { sessions: { ...state.sessions, [sessionId]: session } };
}

/** Each tab belongs to one group. Only the primary group can host native browser tabs. */
function normalizeSession(session: SessionPanelState, pruneEmpty = false): SessionPanelState {
  const assigned = new Set<string>();
  let panes = session.panes.slice(0, 3).map((pane, index) => {
    const tabIds = session.tabs.filter(tab => pane.tabIds.includes(tab.id) && !assigned.has(tab.id) && (index === 0 || tab.type === "artifact")).map(tab => tab.id);
    tabIds.forEach(id => assigned.add(id));
    return { ...pane, tabIds, activeTabId: tabIds.includes(pane.activeTabId ?? "") ? pane.activeTabId : tabIds[0] ?? null };
  });
  if (!panes.length) panes = [{ id: "main", tabIds: [], activeTabId: null }];
  const unassigned = session.tabs.filter(tab => !assigned.has(tab.id)).map(tab => tab.id);
  panes[0] = { ...panes[0], id: "main", tabIds: [...panes[0].tabIds, ...unassigned], activeTabId: panes[0].activeTabId ?? unassigned[0] ?? null };
  if (pruneEmpty) {
    panes = panes.filter(pane => pane.tabIds.length > 0);
    if (!panes.length) panes = [{ id: "main", tabIds: [], activeTabId: null }];
    panes[0] = { ...panes[0], id: "main" };
  }
  const layout = panes.length === 1 ? "single" : panes.length === 2 && layoutPaneCount(session.layout) !== 2 ? "columns" : session.layout;
  return { ...session, panes, layout, activeTabId: panes[0].activeTabId, sideTabIds: panes[1]?.tabIds ?? [], sideActiveTabId: panes[1]?.activeTabId ?? null };
}

function reconcileOpenArtifactTabs(session: SessionPanelState, targets: Array<{ id: string; name: string; preview: OpenTargetPreview }>): SessionPanelState {
  const targetMap = new Map(targets.map(target => [target.id, target]));
  const tabs = session.tabs.flatMap<PanelTab>(tab => {
    if (tab.type !== "artifact") return [tab];
    const target = targetMap.get(tab.id);
    return target ? [{ ...tab, label: target.name, preview: target.preview }] : tab.value || tab.storage ? [tab] : [];
  });
  return normalizeSession({ ...session, tabs }, tabs.length < session.tabs.length);
}

function neighbour(session: SessionPanelState, pane: DocumentPaneState, tabId: string) {
  const ordered = session.tabs.filter(tab => pane.tabIds.includes(tab.id)).map(tab => tab.id);
  const index = ordered.indexOf(tabId);
  const left = ordered.filter(id => id !== tabId);
  return left[index] ?? left[index - 1] ?? null;
}

function moveTab(state: PanelTabStore, sessionId: string, tabId: string, to: string) {
  const session = getWritableSession(state, sessionId);
  const source = session.panes.find(pane => pane.tabIds.includes(tabId));
  if (session.tabs.find(tab => tab.id === tabId)?.type !== "artifact" || !source || source.id === to) return state;
  if (source.id === "main" && source.tabIds.length <= 1) return state;
  const destination = session.panes.find(pane => pane.id === to);
  if (!destination && session.panes.length >= 3) return state;
  if (!confirmDiscardSessionDocuments(sessionId, [destination?.activeTabId ?? null], undefined, true)) return state;
  const panes = destination ? session.panes : [...session.panes, { id: to, tabIds: [], activeTabId: null }];
  return updateSession(state, sessionId, normalizeSession({ ...session,
    layout: panes.length === 3 && layoutPaneCount(session.layout) < 3 ? "three-columns" : session.layout,
    panes: panes.map(pane => pane.id === to ? { ...pane, tabIds: [...pane.tabIds, tabId], activeTabId: tabId }
      : pane.id === source.id ? { ...pane, tabIds: pane.tabIds.filter(id => id !== tabId), activeTabId: pane.activeTabId === tabId ? neighbour(session, pane, tabId) : pane.activeTabId } : pane),
  }, true));
}

function changeLayout(sessionId: string, session: SessionPanelState, layout: DocumentLayout) {
  const count = layoutPaneCount(layout);
  let panes = session.panes.map(pane => ({ ...pane, tabIds: [...pane.tabIds] }));
  if (panes.length > count) {
    const removed = panes.slice(count);
    if (!confirmDiscardSessionDocuments(sessionId, removed.map(pane => pane.activeTabId), undefined, true)) return session;
    panes = panes.slice(0, count);
    panes[0].tabIds.push(...removed.flatMap(pane => pane.tabIds));
  }
  while (panes.length < count) {
    const id = ["side", "third"].find(id => !panes.some(pane => pane.id === id));
    if (!id) break;
    // Fill new panes from hidden document tabs, preserving every visible editor.
    const source = panes.find(pane => pane.tabIds.some(id => id !== pane.activeTabId && session.tabs.some(tab => tab.id === id && tab.type === "artifact")));
    const tabId = source?.tabIds.find(id => id !== source.activeTabId && session.tabs.some(tab => tab.id === id && tab.type === "artifact"));
    if (source && tabId) source.tabIds = source.tabIds.filter(id => id !== tabId);
    panes.push({ id, tabIds: tabId ? [tabId] : [], activeTabId: tabId ?? null });
  }
  return normalizeSession({ ...session, panes, layout });
}

function isSameTranscriptArtifactTargets(left: OpenTarget[], right: OpenTarget[]) {
  return (
    left.length === right.length &&
    left.every((target, index) => target.id === right[index]?.id)
  );
}

function resolveActiveTabId<Tab extends { id: string }>(
  tabs: Tab[],
  preferredActiveTabId: string | null,
): string | null {
  if (preferredActiveTabId && tabs.some((tab) => tab.id === preferredActiveTabId)) {
    return preferredActiveTabId;
  }

  return tabs[0]?.id ?? null;
}

function isSameTab(left: PanelTab, right: PanelTab) {
  if (left.id !== right.id || left.type !== right.type) {
    return false;
  }

  if (left.type === "artifact" && right.type === "artifact") {
    return (
      left.label === right.label &&
      left.preview === right.preview &&
      left.value === right.value &&
      left.storage === right.storage
    );
  }

  if (left.type === "browser" && right.type === "browser") {
    return (
      left.label === right.label &&
      left.url === right.url &&
      left.favicon === right.favicon &&
      left.status === right.status &&
      left.canGoBack === right.canGoBack &&
      left.canGoForward === right.canGoForward
    );
  }

  if (left.type === "task" && right.type === "task") {
    return left.label === right.label && left.taskId === right.taskId;
  }

  if (left.type === "workflow" && right.type === "workflow") return left.label === right.label;
  if (left.type === "workflow-resource" && right.type === "workflow-resource") return left.label === right.label;

  return false;
}

function isSameSessionPanelState(session: SessionPanelState, next: SessionPanelState) {
  return session.tabs.length === next.tabs.length && session.layout === next.layout &&
    JSON.stringify(session.panes) === JSON.stringify(next.panes) && session.tabs.every((tab, index) => isSameTab(tab, next.tabs[index]));
}

function mergePersistedSessions(
  persistedState: unknown,
  currentState: PanelTabStore,
): PanelTabStore {
  if (!record(persistedState) || !record(persistedState.sessions)) return currentState;
  const sessions: Record<string, SessionPanelState> = {};
  for (const [sessionId, session] of Object.entries(persistedState.sessions)) {
    if (!record(session) || !Array.isArray(session.tabs)) continue;
    const tabs = session.tabs.flatMap((value: unknown) => {
      const tab = restoredTab(value);
      return tab ? [tab] : [];
    }).filter((tab, index, all) => all.findIndex((other) => other.id === tab.id) === index);
    const active = typeof session.activeTabId === "string" ? session.activeTabId : null;
    const sideIds = Array.isArray(session.sideTabIds) ? session.sideTabIds.filter((id): id is string => typeof id === "string") : [];
    const panes: DocumentPaneState[] = Array.isArray(session.panes) ? session.panes.flatMap((pane: unknown) => {
      if (!record(pane) || typeof pane.id !== "string" || !Array.isArray(pane.tabIds)) return [];
      return [{ id: pane.id, tabIds: pane.tabIds.filter((id): id is string => typeof id === "string"), activeTabId: typeof pane.activeTabId === "string" ? pane.activeTabId : null }];
    }) : [{ id: "main", tabIds: tabs.filter(tab => !sideIds.includes(tab.id)).map(tab => tab.id), activeTabId: active },
      ...(sideIds.length ? [{ id: "side", tabIds: sideIds, activeTabId: typeof session.sideActiveTabId === "string" ? session.sideActiveTabId : null }] : [])];
    const layout = DOCUMENT_LAYOUTS.find(layout => layout === session.layout) ?? (panes.length > 1 ? "columns" : "single");
    const sizes: Record<string, Record<string, number>> = {};
    if (record(session.sizes)) for (const [key, value] of Object.entries(session.sizes)) {
      if (record(value)) sizes[key] = Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] >= 0 && entry[1] <= 100));
    }
    sessions[sessionId] = normalizeSession({ ...EMPTY_SESSION, tabs, panes, layout, sizes });
  }

  return {
    ...currentState,
    sessions,
  };
}

export const usePanelTabStore = create<PanelTabStore>()(
  persist(
    (set, get) => ({
      sessions: {},
      transcriptArtifactTargets: {},
      setStorageWorkingPath: (sessionId, tabId, path) => set((state) => {
        const session = getWritableSession(state, sessionId);
        const tab = session.tabs.find((item) => item.id === tabId);
        if (tab?.type !== "artifact" || !tab.storage || tab.value === path) return state;
        return updateSession(state, sessionId, { ...session, tabs: session.tabs.map((item) => item.id === tabId ? { ...tab, value: path } : item) });
      }),
      openTab: (sessionId, tab, paneId) => set((state) => {
        const session = getWritableSession(state, sessionId);
        const existing = session.tabs.find(entry => entry.id === tab.id ||
          (tab.type === "artifact" && entry.type === "artifact" && !tab.storage && !entry.storage && tab.value && tab.value === entry.value));
        if (existing) tab = { ...existing, ...tab, id: existing.id };
        const source = session.panes.find(pane => pane.tabIds.includes(tab.id));
        let destinationId = tab.type === "artifact" ? paneId ?? source?.id ?? "main" : "main";
        if (session.panes.length === 1 && !session.tabs.some(entry => entry.id !== tab.id)) destinationId = "main";
        const destination = session.panes.find(pane => pane.id === destinationId);
        if (!destination && session.panes.length >= 3) return state;
        if (destination?.activeTabId !== tab.id && !confirmDiscardSessionDocuments(sessionId, [destination?.activeTabId ?? null], undefined, true)) return state;
        const tabs = existing ? session.tabs.map(entry => entry.id === tab.id ? tab : entry) : [...session.tabs, tab];
        const panes = destination ? session.panes : [...session.panes, { id: destinationId, tabIds: [], activeTabId: null }];
        return updateSession(state, sessionId, normalizeSession({ ...session, tabs,
          layout: panes.length === 3 && layoutPaneCount(session.layout) < 3 ? "three-columns" : session.layout,
          panes: panes.map(pane => pane.id === destinationId ? { ...pane, tabIds: [...pane.tabIds.filter(id => id !== tab.id), tab.id], activeTabId: tab.id }
            : { ...pane, tabIds: pane.tabIds.filter(id => id !== tab.id), activeTabId: pane.activeTabId === tab.id ? neighbour(session, pane, tab.id) : pane.activeTabId }),
        }, Boolean(source && source.id !== destinationId)));
      }),
      closeTab: (sessionId, tabId) => set(state => {
        const session = getWritableSession(state, sessionId);
        const closing = session.tabs.find(tab => tab.id === tabId);
        const pane = session.panes.find(pane => pane.tabIds.includes(tabId));
        if (!closing || !pane) return state;
        if (closing.type === "workflow" || closing.type === "workflow-resource") {
          if (!confirmDiscardSessionDocuments(sessionId, [tabId])) return state;
        } else if (pane.activeTabId === tabId && !confirmDiscardSessionDocuments(sessionId, [tabId], undefined, true)) return state;
        return updateSession(state, sessionId, normalizeSession({ ...session, tabs: session.tabs.filter(tab => tab.id !== tabId),
          panes: session.panes.map(entry => entry.id === pane.id ? { ...entry, tabIds: entry.tabIds.filter(id => id !== tabId), activeTabId: entry.activeTabId === tabId ? neighbour(session, entry, tabId) : entry.activeTabId } : entry),
        }, true));
      }),
      selectTab: (sessionId, tabId) => set(state => {
        const session = getWritableSession(state, sessionId);
        const pane = session.panes.find(pane => pane.tabIds.includes(tabId));
        if (!pane || pane.activeTabId === tabId || !confirmDiscardSessionDocuments(sessionId, [pane.activeTabId], undefined, true)) return state;
        return updateSession(state, sessionId, normalizeSession({ ...session, panes: session.panes.map(entry => entry.id === pane.id ? { ...entry, activeTabId: tabId } : entry) }));
      }),
      moveTab: (sessionId, tabId, pane) => set(state => moveTab(state, sessionId, tabId, pane)),
      setLayout: (sessionId, layout) => set(state => updateSession(state, sessionId, changeLayout(sessionId, getWritableSession(state, sessionId), layout))),
      setPaneSizes: (sessionId, layout, sizes) => set(state => {
        const session = getWritableSession(state, sessionId);
        return updateSession(state, sessionId, { ...session, sizes: { ...session.sizes, [layout]: sizes } });
      }),
      moveTabToSide: (sessionId, tabId) => set(state => moveTab(state, sessionId, tabId, "side")),
      moveTabToMain: (sessionId, tabId) => set(state => moveTab(state, sessionId, tabId, "main")),
      reorderTabs: (sessionId, tabIds) => set((state) => {
        const session = getWritableSession(state, sessionId);
        const tabsById = new Map(session.tabs.map((tab) => [tab.id, tab]));
        const order = tabIds.filter((tabId, index) => tabsById.has(tabId) && tabIds.indexOf(tabId) === index);
        const reordered = new Set(order);
        let next = 0;
        const reorderedTabs = session.tabs.map((tab) => reordered.has(tab.id) ? tabsById.get(order[next++]) ?? tab : tab);

        if (next !== order.length) {
          return state;
        }

        return updateSession(state, sessionId, {
          ...session,
          tabs: reorderedTabs,
        });
      }),
      syncBrowserTabs: (sessionId, browserTabs, activeBrowserTabId) => set((state) => {
        const session = getWritableSession(state, sessionId);
        const browserTabsById = new Map(browserTabs.map((tab) => [tab.id, tab]));

        const mergedTabs: PanelTab[] = [];

        for (const tab of session.tabs) {
          if (tab.type !== "browser") {
            mergedTabs.push(tab);
            continue;
          }

          const browserTab = browserTabsById.get(tab.id);
          if (browserTab) {
            mergedTabs.push(browserTab);
            browserTabsById.delete(tab.id);
          }
        }

        for (const browserTab of browserTabsById.values()) {
          mergedTabs.push(browserTab);
        }

        const currentActiveTab = session.tabs.find((tab) => tab.id === session.activeTabId);
        const shouldSyncActiveFromElectron =
          !session.activeTabId || currentActiveTab?.type === "browser";

        const nextSession = normalizeSession({ ...session, tabs: mergedTabs, panes: session.panes.map((pane, index) => index === 0 ? {
          ...pane,
          tabIds: [...pane.tabIds, ...browserTabs.filter(tab => !pane.tabIds.includes(tab.id)).map(tab => tab.id)],
          activeTabId: shouldSyncActiveFromElectron ? activeBrowserTabId : pane.activeTabId,
        } : pane) }, mergedTabs.length < session.tabs.length);

        if (isSameSessionPanelState(session, nextSession)) {
          return state;
        }

        return updateSession(state, sessionId, nextSession);
      }),
      syncArtifactTargets: (sessionId, targets) => set((state) => {
        const session = getWritableSession(state, sessionId);
        const nextSession = reconcileOpenArtifactTabs(session, targets);

        if (isSameSessionPanelState(session, nextSession)) {
          return state;
        }

        return updateSession(state, sessionId, nextSession);
      }),
      syncTranscriptArtifacts: (sessionId, targets) => set((state) => {
        const currentTranscript = state.transcriptArtifactTargets[sessionId] ?? [];
        const session = getWritableSession(state, sessionId);
        const collectibleTargets = targets
          .filter(isCollectibleArtifactTarget)
          .map((target) => ({
            id: target.id,
            name: target.name,
            preview: target.preview,
          }));
        const nextSession = reconcileOpenArtifactTabs(session, collectibleTargets);
        const transcriptChanged = !isSameTranscriptArtifactTargets(currentTranscript, targets);
        const sessionChanged = !isSameSessionPanelState(session, nextSession);

        if (!transcriptChanged && !sessionChanged) {
          return state;
        }

        const sessionUpdate = sessionChanged ? updateSession(state, sessionId, nextSession) : null;

        return {
          transcriptArtifactTargets: transcriptChanged ? {
            ...state.transcriptArtifactTargets,
            [sessionId]: targets,
          } : state.transcriptArtifactTargets,
          sessions: sessionUpdate?.sessions ?? state.sessions,
        };
      }),
      clearSession: (sessionId) => set((state) => {
        const nextSessions = { ...state.sessions };
        const nextTranscriptArtifactTargets = { ...state.transcriptArtifactTargets };
        
        let changed = false;

        if (state.sessions[sessionId]) {
          delete nextSessions[sessionId];
          changed = true;
        }

        if (state.transcriptArtifactTargets[sessionId]) {
          delete nextTranscriptArtifactTargets[sessionId];
          changed = true;
        }

        if (!changed) {
          return state;
        }

        return {
          sessions: nextSessions,
          transcriptArtifactTargets: nextTranscriptArtifactTargets,
        };
      }),
    }),
    {
      name: PERSISTED_PANEL_TAB_STORE_KEY,
      storage: createJSONStorage(() => {
        if (typeof window === "undefined" || !window.location.href.includes("detached=1")) return localStorage;
        return {
          getItem: key => sessionStorage.getItem(key) ?? localStorage.getItem(key),
          setItem: (key, value) => sessionStorage.setItem(key, value),
          removeItem: key => sessionStorage.removeItem(key),
        };
      }),
      partialize: (state) => ({
        sessions: Object.fromEntries(
          Object.entries(state.sessions).map(([sessionId, session]) => {
            const tabs = session.tabs
              .flatMap<PersistedPanelTab>((tab) => {
                if (tab.type === "browser") return [{ id: tab.id, type: tab.type }];
                // Restore original workspace files, not downloaded credentials,
                // cached storage working copies or ephemeral evidence viewers.
                if (tab.type === "artifact" && tab.value && !tab.storage && !tab.searchSources && !tab.reviewCitation && !tab.reviewRecognition)
                  return [{ id: tab.id, type: tab.type, label: tab.label, value: tab.value }];
                return [];
              });

            return [
              sessionId,
              {
                tabs,
                activeTabId: resolveActiveTabId(tabs, session.activeTabId),
                sideTabIds: session.sideTabIds,
                sideActiveTabId: session.sideActiveTabId,
                panes: session.panes,
                layout: session.layout,
                sizes: session.sizes,
              },
            ];
          }),
        ),
      }),
      merge: (persistedState, currentState) => mergePersistedSessions(persistedState, currentState),
    },
  ),
);

export function useSessionPanelState(sessionId: string): SessionPanelState {
  return usePanelTabStore((state) => state.sessions[sessionId] ?? EMPTY_SESSION);
}

export function useActivePanelTab(sessionId: string): PanelTab | null {
  return usePanelTabStore((state) => {
    const session = state.sessions[sessionId] ?? EMPTY_SESSION;

    return session.tabs.find((tab) => tab.id === session.activeTabId) ?? session.tabs[0] ?? null;
  });
}
