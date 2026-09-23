import type { SearchSourceReference } from "@legalwork/types/search";
import { create } from "zustand";
import type { ReviewSourceReference } from "@legalwork/types/reviews";
import { confirmDiscardDocuments, confirmDiscardSessionDocuments } from "../artifacts/docx-document-state";
import { createJSONStorage, persist } from "zustand/middleware";

import { isCollectibleArtifactTarget, type OpenTarget, type OpenTargetPreview } from "../artifacts/open-target";
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

export type SessionPanelState = {
  tabs: PanelTab[];
  activeTabId: string | null;
  // Document tabs shown in a second pane beside the main one. A tab sits in
  // one pane only, so no document is ever mounted twice.
  sideTabIds: string[];
  sideActiveTabId: string | null;
};

type PersistedPanelTabRef = {
  id: string;
  type: PanelTabType;
};

type PersistedSessionPanelState = {
  tabs: PersistedPanelTabRef[];
  activeTabId: string | null;
};

type PersistedPanelTabStore = {
  sessions: Record<string, PersistedSessionPanelState>;
};

export type PanelTabStore = {
  sessions: Record<string, SessionPanelState>;
  transcriptArtifactTargets: Record<string, OpenTarget[]>;
  openTab: (sessionId: string, tab: PanelTab) => void;
  setStorageWorkingPath: (sessionId: string, tabId: string, path: string) => void;
  closeTab: (sessionId: string, tabId: string) => void;
  selectTab: (sessionId: string, tabId: string) => void;
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
  tabs: [],
  activeTabId: null,
  sideTabIds: [],
  sideActiveTabId: null,
};

function getWritableSession(state: PanelTabStore, sessionId: string): SessionPanelState {
  return state.sessions[sessionId] ?? EMPTY_SESSION;
}

function updateSession(
  state: PanelTabStore,
  sessionId: string,
  session: SessionPanelState,
): Partial<PanelTabStore> {
  return {
    sessions: {
      ...state.sessions,
      [sessionId]: session,
    },
  };
}

function reconcileOpenArtifactTabs(
  session: SessionPanelState,
  targets: Array<{ id: string; name: string; preview: OpenTargetPreview }>,
): SessionPanelState {
  const targetMap = new Map(targets.map((target) => [target.id, target]));

  const tabs = session.tabs
    .map((tab) => {
      if (tab.type !== "artifact") {
        return tab;
      }

      const target = targetMap.get(tab.id);

      if (!target) {
        // Workspace and connected-storage tabs carry their own source. A
        // transcript update must not close directly opened files.
        return tab.value || tab.storage ? tab : null;
      }

      return {
        ...tab,
        label: target.name,
        preview: target.preview,
      };
    })
    .filter((tab): tab is PanelTab => tab !== null);

  return normalizeSession(tabs, session.activeTabId, session.sideTabIds, session.sideActiveTabId);
}

/** Every write goes through here so both panes always point at tabs that exist:
 * only document tabs may sit in the side pane, each active id resolves within
 * its own pane, and the side pane closes rather than outlive an empty main pane. */
function normalizeSession(
  tabs: PanelTab[],
  activeTabId: string | null,
  sideTabIds: string[],
  sideActiveTabId: string | null,
): SessionPanelState {
  const documentIds = new Set(tabs.flatMap((tab) => tab.type === "artifact" ? [tab.id] : []));
  const sideIds = sideTabIds.filter((id, index) => documentIds.has(id) && sideTabIds.indexOf(id) === index);
  const sideSet = new Set(sideIds);
  const mainTabs = tabs.filter((tab) => !sideSet.has(tab.id));
  if (!mainTabs.length && sideIds.length) {
    return normalizeSession(tabs, sideActiveTabId, [], null);
  }
  const sideTabs = tabs.filter((tab) => sideSet.has(tab.id));

  return {
    tabs,
    activeTabId: resolveActiveTabId(mainTabs, activeTabId),
    sideTabIds: sideIds,
    sideActiveTabId: resolveActiveTabId(sideTabs, sideActiveTabId),
  };
}

/** The tab that takes over when a tab leaves its pane: the one after it, else
 * the one before it, within that pane only, so focus never jumps the split. */
function neighbourInPane(session: SessionPanelState, tabId: string) {
  const sideSet = new Set(session.sideTabIds);
  const inSide = sideSet.has(tabId);
  const pane = session.tabs.filter((tab) => sideSet.has(tab.id) === inSide);
  const index = pane.findIndex((tab) => tab.id === tabId);
  const remaining = pane.filter((tab) => tab.id !== tabId);
  return remaining[index]?.id ?? remaining[index - 1]?.id ?? null;
}

function moveTab(state: PanelTabStore, sessionId: string, tabId: string, to: "main" | "side") {
  const session = getWritableSession(state, sessionId);
  const tab = session.tabs.find((entry) => entry.id === tabId);
  const inSide = session.sideTabIds.includes(tabId);
  if (tab?.type !== "artifact" || inSide === (to === "side")) {
    return state;
  }

  // The moved tab remounts in its new pane and takes over as that pane's
  // active document, so both may lose unsaved changes.
  const replaced = to === "side" ? session.sideActiveTabId : session.activeTabId;
  if (!confirmDiscardSessionDocuments(sessionId, [tabId, replaced], undefined, true)) return state;

  const sideTabIds = to === "side"
    ? [...session.sideTabIds, tabId]
    : session.sideTabIds.filter((id) => id !== tabId);
  const wasActive = (inSide ? session.sideActiveTabId : session.activeTabId) === tabId;
  const left = wasActive ? neighbourInPane(session, tabId) : null;

  return updateSession(state, sessionId, normalizeSession(
    session.tabs,
    to === "main" ? tabId : wasActive ? left : session.activeTabId,
    sideTabIds,
    to === "side" ? tabId : wasActive ? left : session.sideActiveTabId,
  ));
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
  return (
    session.tabs.length === next.tabs.length &&
    session.activeTabId === next.activeTabId &&
    session.sideActiveTabId === next.sideActiveTabId &&
    session.sideTabIds.length === next.sideTabIds.length &&
    session.sideTabIds.every((id, index) => id === next.sideTabIds[index]) &&
    session.tabs.every((tab, index) => isSameTab(tab, next.tabs[index]))
  );
}

function mergePersistedSessions(
  persistedState: unknown,
  currentState: PanelTabStore,
): PanelTabStore {
  const persisted = persistedState as PersistedPanelTabStore | undefined;

  if (!persisted?.sessions) {
    return currentState;
  }

  const sessions: Record<string, SessionPanelState> = {};

  for (const [sessionId, session] of Object.entries(persisted.sessions)) {
    const tabs = session.tabs
      .filter(({ type }) => type === "browser")
      .map(({ id }): PanelTab => ({
        id,
        type: "browser",
        label: "New tab",
        url: "",
        favicon: null,
        status: "ready",
        canGoBack: false,
        canGoForward: false,
      }));

    sessions[sessionId] = normalizeSession(tabs, session.activeTabId, [], null);
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
      openTab: (sessionId, tab) => set((state) => {
        const session = getWritableSession(state, sessionId);
        // A tab already beside the main pane is shown there again rather than
        // pulled back, so a document keeps the pane the user gave it.
        const inSide = session.sideTabIds.includes(tab.id);
        const replaced = inSide ? session.sideActiveTabId : session.activeTabId;
        if (replaced !== tab.id && !confirmDiscardSessionDocuments(sessionId, [replaced], undefined, true)) return state;
        const existingIndex = session.tabs.findIndex((entry) => entry.id === tab.id);
        const tabs = existingIndex >= 0
          ? session.tabs.map((entry, index) => index === existingIndex ? tab : entry)
          : [...session.tabs, tab];

        return updateSession(state, sessionId, normalizeSession(
          tabs,
          inSide ? session.activeTabId : tab.id,
          session.sideTabIds,
          inSide ? tab.id : session.sideActiveTabId,
        ));
      }),
      closeTab: (sessionId, tabId) => set((state) => {
        const session = getWritableSession(state, sessionId);
        const closing = session.tabs.find((tab) => tab.id === tabId);
        if (!closing) {
          return state;
        }

        const inSide = session.sideTabIds.includes(tabId);
        const wasActive = (inSide ? session.sideActiveTabId : session.activeTabId) === tabId;
        if (closing.type === "workflow" || closing.type === "workflow-resource") {
          if (!confirmDiscardDocuments(tabId)) return state;
        } else if (wasActive && !confirmDiscardSessionDocuments(sessionId, [tabId], undefined, true)) return state;
        const nextActiveId = wasActive ? neighbourInPane(session, tabId) : null;

        return updateSession(state, sessionId, normalizeSession(
          session.tabs.filter((tab) => tab.id !== tabId),
          !inSide && wasActive ? nextActiveId : session.activeTabId,
          session.sideTabIds.filter((id) => id !== tabId),
          inSide && wasActive ? nextActiveId : session.sideActiveTabId,
        ));
      }),
      selectTab: (sessionId, tabId) => set((state) => {
        const session = getWritableSession(state, sessionId);
        if (!session.tabs.some((tab) => tab.id === tabId)) {
          return state;
        }

        const inSide = session.sideTabIds.includes(tabId);
        const current = inSide ? session.sideActiveTabId : session.activeTabId;
        if (current === tabId) {
          return state;
        }

        if (!confirmDiscardSessionDocuments(sessionId, [current], undefined, true)) return state;
        return updateSession(state, sessionId, {
          ...session,
          activeTabId: inSide ? session.activeTabId : tabId,
          sideActiveTabId: inSide ? tabId : session.sideActiveTabId,
        });
      }),
      moveTabToSide: (sessionId, tabId) => set((state) => moveTab(state, sessionId, tabId, "side")),
      moveTabToMain: (sessionId, tabId) => set((state) => moveTab(state, sessionId, tabId, "main")),
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

        const nextSession = normalizeSession(
          mergedTabs,
          shouldSyncActiveFromElectron ? activeBrowserTabId : session.activeTabId,
          session.sideTabIds,
          session.sideActiveTabId,
        );

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
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        sessions: Object.fromEntries(
          Object.entries(state.sessions).map(([sessionId, session]) => {
            const tabs = session.tabs
              .filter((tab) => tab.type === "browser")
              .map(({ id, type }) => ({ id, type }));

            return [
              sessionId,
              {
                tabs,
                activeTabId: resolveActiveTabId(tabs, session.activeTabId),
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
