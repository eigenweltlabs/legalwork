import { isWorkspacePanelScope } from "./panel-scope";
import { suggestionIdFromFile } from "@legalwork/types/wiki-suggestions";
import { useViewGenerationStore, replaceGenerationTab, type ViewDraftTab } from "../../views/view-generation";
import { parseViewReference, viewPanelTab, type ViewPanelTab } from "../../views/view-reference";
import { projectFileSourceSchema, type ProjectFileSource } from "@legalwork/types/project-files";
import { projectFileTab } from "../../workspace/project-file-tab";
import { isProjectView, type ProjectView } from "./project-view";
export type { ProjectView } from "./project-view";
import type { SearchSourceReference } from "@legalwork/types/search";
import { create } from "zustand";
import type { ReviewSourceReference } from "@legalwork/types/reviews";
import { hasUnsavedSessionDocument, confirmDiscardSessionDocuments } from "../artifacts/docx-document-state";
import { createJSONStorage, persist } from "zustand/middleware";

import { classifyOpenTarget, isCollectibleArtifactTarget, type OpenTarget, type OpenTargetPreview } from "../artifacts/open-target";
import type { StorageFileSource } from "./storage-file-tab";
import { wikiPanelTab, type WikiPanelTab } from "../../wiki/wiki-tabs";
import { isLoopbackLegalworkServerUrl } from "@/app/lib/legalwork-server";
import { storageFileSourceSchema, storageFileTab } from "./storage-file-tab";
import { MAX_DOCUMENT_PANES, legacyLayout, legacyLayoutSizes, layoutLeaves, findLayoutNode, pruneLayout, reconcileLayoutSizes, restoreLayout, splitLayout, type DocumentDropEdge, type DocumentLayoutNode } from "./document-layout";

import { automaticTabDestination, DEFAULT_WORKSPACE_OPENING, MIN_AUTO_SPLIT_WIDTH, restoreWorkspaceOpening, type WorkspaceOpening } from "./workspace-opening";

// Measurements are per window and must not trigger persisted layout writes during resize.
const workspaceWidths = new Map<string, number>();
const latestBrowserStates = new Map<string, { tabs: BrowserPanelTab[]; activeId: string | null }>();

export const PERSISTED_PANEL_TAB_STORE_KEY = "legalwork:panel-tabs:v1";

/**
 * Synthetic session key for the right panel on top-level mainView pages
 * (Evals / Benchmark): artifact tabs opened outside a chat session live here.
 */
export const EVALS_PANEL_SESSION_ID = "__evals__";

// Asking for a tab lives in its own module, so asking does not create this store.
export { PANEL_OPEN_TAB_EVENT, requestPanelTab } from "./panel-tab-request";

export type PanelTabType = PanelTab["type"];

export function workspacePanelKey(workspaceId: string) { return `workspace:${workspaceId}`; }
export type ProjectViewTab = { id: string; type: "project-view"; view: ProjectView; label: string };
export function projectViewTab(view: ProjectView, label: string): ProjectViewTab {
  return { id: `project-view:${view}`, type: "project-view", view, label };
}
export type ChatPanelTab = { id: string; type: "chat"; sessionId: string; label: string };
export type ReviewPanelTab = { id: string; type: "review"; reviewId: string; label: string };
export function chatPanelTab(sessionId: string, label: string): ChatPanelTab {
  return { id: `chat:${sessionId}`, type: "chat", sessionId, label };
}

export type { BrowserPanelTab } from "../../../../app/lib/desktop-types";
import type { BrowserPanelTab } from "../../../../app/lib/desktop-types";

export type ArtifactPanelTab = {
  id: string;
  type: "artifact";
  label: string;
  preview: OpenTargetPreview;
  sourceSessionId?: string;
  wikiSuggestion?: { workspaceId: string; id: string };
  sourceProject?: ProjectFileSource;
  // Workspace-relative path for tabs opened directly from the workspace file
  // browser. Tabs without it resolve through the session's transcript targets.
  value?: string;
  size?: number;
  updatedAt?: number;
  pendingImportId?: string;
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

export type RecordingPanelTab = { id: string; type: "recording"; recordingId: string; label: string };

export type WorkflowPanelTab = { id: string; type: "workflow"; label: string };
export type WorkflowResourcePanelTab = { id: string; type: "workflow-resource"; label: string };

export type PanelTab = ProjectViewTab | ChatPanelTab | ReviewPanelTab | BrowserPanelTab | ArtifactPanelTab | TaskPanelTab | WorkflowPanelTab | WorkflowResourcePanelTab | WikiPanelTab | ViewPanelTab | ViewDraftTab | RecordingPanelTab;

export type DocumentPaneState = { id: string; tabIds: string[]; activeTabId: string | null; previewTabId?: string };
export type SessionPanelState = {
  tabs: PanelTab[];
  focusedPaneId?: string;
  panes: DocumentPaneState[];
  tree: DocumentLayoutNode;
  sizes: Record<string, Record<string, number>>;
  // Compatibility for browser integration and previously persisted two-pane state.
  activeTabId: string | null;
  sideTabIds: string[];
  sideActiveTabId: string | null;
};

type PersistedPanelTab = RecordingPanelTab | ViewPanelTab | WikiPanelTab | ProjectViewTab | ChatPanelTab | ReviewPanelTab | TaskPanelTab | { id: string; type: "browser"; background?: boolean } | { id: string; type: "artifact"; label: string; value: string } | ArtifactPanelTab;
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function restoredTab(value: unknown): PanelTab | null {
  if (!record(value) || typeof value.id !== "string") return null;
  if (value.type === "view" && typeof value.label === "string" && typeof value.serverUrl === "string" && record(value.owner) && typeof value.owner.id === "string" && typeof value.viewId === "string") {
    const ref = parseViewReference(`${value.owner.kind}:${encodeURIComponent(value.owner.id)}/${value.viewId}`);
    return ref ? viewPanelTab(value.serverUrl, ref, value.label) : null;
  }
  if (value.type === "wiki" && typeof value.label === "string" && typeof value.serverUrl === "string" && typeof value.wikiId === "string" && value.wikiId && record(value.location)) {
    const location = value.location;
    if (location.kind === "page" && typeof location.path === "string" && location.path) return wikiPanelTab(value.serverUrl, value.wikiId, { kind: "page", path: location.path, anchor: typeof location.anchor === "string" ? location.anchor : undefined, mode: location.mode === "source" ? "source" : undefined }, value.label);
    if (location.kind === "asset" && typeof location.path === "string" && location.path) return wikiPanelTab(value.serverUrl, value.wikiId, { kind: "asset", path: location.path }, value.label);
    if (location.kind === "graph") return wikiPanelTab(value.serverUrl, value.wikiId, { kind: "graph", focus: typeof location.focus === "string" ? location.focus : undefined }, value.label);
    return null;
  }
  if (value.type === "artifact" && value.sourceProject) {
    const source = projectFileSourceSchema.safeParse(value.sourceProject);
    return source.success ? { ...projectFileTab(source.data), id: value.id } : null;
  }
  if (value.type === "artifact" && value.storage) {
    const storage = storageFileSourceSchema.safeParse(value.storage);
    return storage.success ? storageFileTab(storage.data.workspaceId, storage.data.root, storage.data.file) : null;
  }
  if (value.type === "artifact" && typeof value.label === "string" && typeof value.value === "string" && value.value)
    return { id: value.id, type: "artifact", label: value.label, value: value.value, preview: classifyOpenTarget(value.value, "file"),
      ...(record(value.wikiSuggestion) && typeof value.wikiSuggestion.workspaceId === "string" && typeof value.wikiSuggestion.id === "string" && suggestionIdFromFile(value.value) === value.wikiSuggestion.id ? { wikiSuggestion: { workspaceId: value.wikiSuggestion.workspaceId, id: value.wikiSuggestion.id } } : {}) };
  if (typeof value.label === "string") {
    if (value.type === "recording" && typeof value.recordingId === "string" && value.recordingId) return { id: value.id, type: "recording", recordingId: value.recordingId, label: value.label };
    if (value.type === "project-view" && isProjectView(value.view)) return projectViewTab(value.view, value.label);
    if (value.type === "chat" && typeof value.sessionId === "string") return chatPanelTab(value.sessionId, value.label);
    if (value.type === "review" && typeof value.reviewId === "string") return { id: value.id, type: "review", reviewId: value.reviewId, label: value.label };
    if (value.type === "task" && typeof value.taskId === "string") return { id: value.id, type: "task", taskId: value.taskId, label: value.label };
  }
  if (value.type !== "browser") return null;
  return { id: value.id, type: "browser", background: value.background === true, label: "New tab", url: typeof value.url === "string" ? value.url : "", favicon: null, status: "ready", canGoBack: false, canGoForward: false };
}

export type PanelTabStore = {
  sessions: Record<string, SessionPanelState>;
  opening: Record<string, WorkspaceOpening>;
  setOpening: (scope: string, update: Partial<WorkspaceOpening>) => void;
  setWorkspaceWidth: (scope: string, width: number) => void;
  keepTab: (scope: string, tabId: string) => void;
  readLayout: (value: unknown) => SessionPanelState | null;
  migrateWorkspace: (workspaceId: string) => void;
  adoptChat: (scope: string, sessionId: string, label: string, options?: { preserveLayout: boolean }) => void;
  updateTabLabel: (scope: string, tabId: string, label: string) => void;
  transcriptArtifactTargets: Record<string, OpenTarget[]>;
  openTab: (sessionId: string, tab: PanelTab, pane?: string, edge?: DocumentDropEdge, options?: { preview?: boolean; besideChat?: boolean }) => void;
  resolveViewTab: (draftId: string, saved: ViewPanelTab) => void;
  replaceTab: (tabId: string, replacement: PanelTab) => void;
  finishFileImport: (id: string, file: { path: string; size?: number; updatedAt?: number }) => void;
  setStorageWorkingPath: (sessionId: string, tabId: string, path: string) => void;
  updateWikiPaths: (serverUrl: string, wikiId: string, path: string, destination: string | null) => void;
  reconnectWikiTabs: (serverUrl: string, wikiIds: string[]) => void;
  closeTab: (sessionId: string, tabId: string) => void;
  selectTab: (sessionId: string, tabId: string) => void;
  restoreNavigationTab: (scope: string, tab: unknown, paneId: string) => void;
  moveTab: (sessionId: string, tabId: string, pane: string, edge?: DocumentDropEdge) => void;
  setPaneSizes: (sessionId: string, layout: string, sizes: Record<string, number>) => void;
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
  tabs: [], panes: [{ id: "main", tabIds: [], activeTabId: null }], tree: { type: "pane", id: "main" }, sizes: {},
  activeTabId: null, sideTabIds: [], sideActiveTabId: null, focusedPaneId: "main",
};

function getWritableSession(state: PanelTabStore, sessionId: string): SessionPanelState {
  return state.sessions[sessionId] ?? EMPTY_SESSION;
}
function updateSession(state: PanelTabStore, sessionId: string, session: SessionPanelState): Partial<PanelTabStore> {
  return { sessions: { ...state.sessions, [sessionId]: session } };
}

/** Keep pane ids stable when a group empties; tree order determines geometry. */
export function normalizeSession(session: SessionPanelState): SessionPanelState {
  const assigned = new Set<string>();
  const paneIds = new Set<string>();
  const defaultTab = (ids: string[]) => session.tabs.find(tab => ids.includes(tab.id) && (tab.type !== "browser" || !tab.background))?.id ?? null;
  let panes: DocumentPaneState[] = session.panes.filter(pane => {
    if (paneIds.has(pane.id) || paneIds.size >= MAX_DOCUMENT_PANES) return false;
    paneIds.add(pane.id);
    return true;
  }).map(pane => {
    const tabIds = session.tabs.filter(tab => pane.tabIds.includes(tab.id) && !assigned.has(tab.id)).map(tab => tab.id);
    tabIds.forEach(id => assigned.add(id));
    return { ...pane, tabIds, previewTabId: tabIds.includes(pane.previewTabId ?? "") ? pane.previewTabId : undefined, activeTabId: tabIds.includes(pane.activeTabId ?? "") ? pane.activeTabId : defaultTab(tabIds) };
  });
  if (!panes.length) panes = [{ id: "main", tabIds: [], activeTabId: null }];
  const unassigned = session.tabs.filter(tab => !assigned.has(tab.id)).map(tab => tab.id);
  panes[0] = { ...panes[0], tabIds: [...panes[0].tabIds, ...unassigned], activeTabId: panes[0].activeTabId ?? defaultTab(unassigned) };
  panes = panes.filter(pane => pane.tabIds.length > 0);
  if (!panes.length) panes = [{ id: "main", tabIds: [], activeTabId: null }];
  let tree = pruneLayout(session.tree, new Set(panes.map(pane => pane.id))) ?? { type: "pane", id: panes[0].id };
  for (const pane of panes) {
    if (!layoutLeaves(tree).includes(pane.id)) tree = { type: "split", id: `restored:${pane.id}`, direction: "horizontal", first: tree, second: { type: "pane", id: pane.id } };
  }
  const sizes = reconcileLayoutSizes(session.tree, tree, session.sizes);
  return { ...session, panes, tree, sizes, focusedPaneId: panes.some(pane => pane.id === session.focusedPaneId) ? session.focusedPaneId : panes[0].id, activeTabId: panes[0].activeTabId, sideTabIds: panes[1]?.tabIds ?? [], sideActiveTabId: panes[1]?.activeTabId ?? null };
}

function reconcileOpenArtifactTabs(session: SessionPanelState, targets: Array<{ id: string; name: string; preview: OpenTargetPreview }>): SessionPanelState {
  const targetMap = new Map(targets.map(target => [target.id, target]));
  const tabs = session.tabs.flatMap<PanelTab>(tab => {
    if (tab.type !== "artifact") return [tab];
    const target = targetMap.get(tab.id);
    return target ? [{ ...tab, label: target.name, preview: target.preview }] : tab.value || tab.storage || tab.sourceProject ? [tab] : [];
  });
  return normalizeSession({ ...session, tabs });
}

function neighbour(session: SessionPanelState, pane: DocumentPaneState, tabId: string) {
  const ordered = session.tabs.filter(tab => pane.tabIds.includes(tab.id)).map(tab => tab.id);
  const index = ordered.indexOf(tabId);
  const left = ordered.filter(id => id !== tabId);
  return left[index] ?? left[index - 1] ?? null;
}

export function samePanelTab(scope: string, tab: PanelTab, other: PanelTab) {
  if (tab.type !== "artifact" || other.type !== "artifact") return tab.id === other.id;
  const projectId = scope.startsWith("workspace:") ? scope.slice(10) : undefined;
  const identity = (entry: ArtifactPanelTab) => ({
    project: entry.sourceProject?.projectId ?? projectId,
    workspace: entry.sourceProject?.workspaceId ?? entry.storage?.workspaceId,
    connection: entry.sourceProject?.connectionId ?? entry.storage?.root.id,
    path: entry.sourceProject?.path ?? entry.storage?.file.path ?? entry.value,
  });
  const a = identity(tab), b = identity(other);
  if (!a.path || !b.path) return tab.id === other.id;
  return a.path === b.path && a.project === b.project && a.connection === b.connection &&
    (!a.workspace || !b.workspace || a.workspace === b.workspace);
}

/** A drop is one transaction: validate capacity and any displaced draft before
 * changing membership or geometry. A lone source can relocate at the pane limit. */
function dockTab(sessionId: string, session: SessionPanelState, tab: PanelTab, paneId?: string, edge?: DocumentDropEdge, retry?: () => void): SessionPanelState {
  const existing = session.tabs.find(entry => samePanelTab(sessionId, tab, entry));
  // Alias drops must retain the mounted editor and its draft, including whether
  // the file was opened locally, from connected storage, or through a source link.
  if (existing?.type === "artifact" && tab.type === "artifact" && existing.id !== tab.id) {
    tab = { ...existing, ...tab, id: existing.id, value: existing.value, storage: existing.storage, sourceProject: existing.sourceProject, preview: existing.preview };
  } else if (existing?.type === "view" && tab.type === "view") {
    // Link labels are hints. The mounted viewer updates its authoritative record title.
    tab = { ...existing, ...tab, label: existing.label };
  } else if (existing) tab = { ...existing, ...tab };
  else if (session.tabs.some(entry => entry.id === tab.id)) {
    // Older layouts lowercased file IDs. Keep their mounted drafts intact when
    // a distinct case-sensitive path requests an already occupied legacy ID.
    const requestedId = tab.id;
    let suffix = 2;
    while (session.tabs.some(entry => entry.id === tab.id)) tab = { ...tab, id: `${requestedId}:${suffix++}` };
  }
  const source = session.panes.find(pane => pane.tabIds.includes(tab.id));
  const destination = session.panes.find(pane => pane.id === (paneId ?? source?.id ?? session.focusedPaneId ?? session.panes[0].id));
  // An async cloud import may finish after its drop target was closed.
  if (!destination) return session;
  const split = edge && destination.tabIds.length > 0;
  if (split && source?.id === destination.id && source.tabIds.length === 1) return session;
  const sourceEmpties = source && source.id !== destination.id && source.tabIds.length === 1;
  if (split && session.panes.length + 1 - (sourceEmpties ? 1 : 0) > MAX_DOCUMENT_PANES) return session;
  if (!isWorkspacePanelScope(sessionId) && !split && destination.activeTabId !== tab.id && !confirmDiscardSessionDocuments(sessionId, [destination.activeTabId], undefined, true, retry)) return session;
  const tabs = existing ? session.tabs.map(entry => entry.id === tab.id ? tab : entry) : [...session.tabs, tab];
  const newPaneId = split ? `pane:${crypto.randomUUID()}` : destination.id;
  const panes = session.panes.map(pane => {
    if (pane.id === newPaneId) return { ...pane, tabIds: [...pane.tabIds.filter(id => id !== tab.id), tab.id], activeTabId: tab.id };
    if (pane.id !== source?.id) return pane;
    return { ...pane, tabIds: pane.tabIds.filter(id => id !== tab.id), activeTabId: pane.activeTabId === tab.id ? neighbour(session, pane, tab.id) : pane.activeTabId };
  });
  if (split) panes.push({ id: newPaneId, tabIds: [tab.id], activeTabId: tab.id });
  const tree = split ? splitLayout(session.tree, destination.id, newPaneId, edge, `split:${crypto.randomUUID()}`) : session.tree;
  return normalizeSession({ ...session, tabs, focusedPaneId: newPaneId, panes: panes.filter(pane => pane.tabIds.length > 0), tree, sizes: reconcileLayoutSizes(session.tree, tree, session.sizes) });
}

function openInSession(scope: string, session: SessionPanelState, tab: PanelTab, opening: WorkspaceOpening, width: number, pane?: string, edge?: DocumentDropEdge, preview = false, retry?: () => void) {
  const existing = session.tabs.find(item => samePanelTab(scope, tab, item));
  const automatic = !pane && !edge && !existing && scope.startsWith("workspace:")
    ? automaticTabDestination(session, tab, opening, width) : {};
  let next = dockTab(scope, session, tab, pane ?? automatic.pane, edge ?? automatic.edge, retry);
  if (next === session) return next;
  const id = next.tabs.find(entry => samePanelTab(scope, tab, entry))?.id;
  if (!id) return next;
  const destination = next.panes.find(item => item.tabIds.includes(id));
  if (!destination) return next;
  const eligible = tab.type === "view" || tab.type === "artifact" || tab.type === "task" || tab.type === "review";
  if (preview && eligible && !existing && !edge) {
    const previous = destination.previewTabId;
    if (previous && previous !== id && !hasUnsavedSessionDocument(scope, previous)) {
      next = { ...next, tabs: next.tabs.filter(item => item.id !== previous) };
    }
    next = { ...next, panes: next.panes.map(item => item.id === destination.id ? { ...item, previewTabId: id } : item) };
  } else if (!preview || pane || edge) {
    next = { ...next, panes: next.panes.map(item => item.previewTabId === id ? { ...item, previewTabId: undefined } : item) };
  }
  return normalizeSession(next);
}

function isSameTranscriptArtifactTargets(left: OpenTarget[], right: OpenTarget[]) {
  return (
    left.length === right.length &&
    left.every((target, index) => target.id === right[index]?.id)
  );
}

function resolveActiveTabId<Tab extends { id: string; type: string; background?: boolean }>(
  tabs: Tab[],
  preferredActiveTabId: string | null,
): string | null {
  if (preferredActiveTabId && tabs.some((tab) => tab.id === preferredActiveTabId)) {
    return preferredActiveTabId;
  }

  return tabs.find(tab => tab.type !== "browser" || !tab.background)?.id ?? null;
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
      left.background === right.background &&
      left.label === right.label &&
      left.url === right.url &&
      left.favicon === right.favicon &&
      left.status === right.status &&
      left.canGoBack === right.canGoBack &&
      left.canGoForward === right.canGoForward
    );
  }

  if (left.type === "project-view" && right.type === "project-view") return left.view === right.view && left.label === right.label;
  if (left.type === "chat" && right.type === "chat") return left.label === right.label && left.sessionId === right.sessionId;
  if (left.type === "review" && right.type === "review") return left.label === right.label && left.reviewId === right.reviewId;
  if (left.type === "task" && right.type === "task") {
    return left.label === right.label && left.taskId === right.taskId;
  }

  if (left.type === "recording" && right.type === "recording") {
    return left.label === right.label && left.recordingId === right.recordingId;
  }

  if (left.type === "workflow" && right.type === "workflow") return left.label === right.label;
  if (left.type === "workflow-resource" && right.type === "workflow-resource") return left.label === right.label;
  if (left.type === "view" && right.type === "view") return left.label === right.label && left.serverUrl === right.serverUrl && left.viewId === right.viewId && left.owner.kind === right.owner.kind && left.owner.id === right.owner.id;
  if (left.type === "wiki" && right.type === "wiki") return left.label === right.label && left.serverUrl === right.serverUrl && left.wikiId === right.wikiId && JSON.stringify(left.location) === JSON.stringify(right.location);

  return false;
}

function isSameSessionPanelState(session: SessionPanelState, next: SessionPanelState) {
  return session.focusedPaneId === next.focusedPaneId && session.tabs.length === next.tabs.length && JSON.stringify(session.tree) === JSON.stringify(next.tree) &&
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
      return [{ id: pane.id, tabIds: pane.tabIds.filter((id): id is string => typeof id === "string"), activeTabId: typeof pane.activeTabId === "string" ? pane.activeTabId : null, previewTabId: typeof pane.previewTabId === "string" ? pane.previewTabId : undefined }];
    }) : [{ id: "main", tabIds: tabs.filter(tab => !sideIds.includes(tab.id)).map(tab => tab.id), activeTabId: active },
      ...(sideIds.length ? [{ id: "side", tabIds: sideIds, activeTabId: typeof session.sideActiveTabId === "string" ? session.sideActiveTabId : null }] : [])];
    const paneIds = [...new Set(panes.map(pane => pane.id))].slice(0, MAX_DOCUMENT_PANES);
    const tree = restoreLayout(session.tree, new Set(paneIds)) ?? legacyLayout(paneIds, session.layout);
    const sizes: Record<string, Record<string, number>> = {};
    if (record(session.sizes)) for (const [key, value] of Object.entries(session.sizes)) {
      if (record(value)) sizes[key] = Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] >= 0 && entry[1] <= 100));
    }
    sessions[sessionId] = normalizeSession({ ...EMPTY_SESSION, tabs, panes, tree, focusedPaneId: typeof session.focusedPaneId === "string" ? session.focusedPaneId : undefined, sizes: session.tree ? sizes : legacyLayoutSizes(tree, session.layout, panes.map(pane => pane.id), sizes) });
  }

  return {
    ...currentState,
    sessions,
    opening: record(persistedState.opening) ? Object.fromEntries(Object.entries(persistedState.opening).map(([key, value]) => [key, restoreWorkspaceOpening(value)])) : {},
  };
}

export const createPanelTabStore = () => create<PanelTabStore>()(
  persist(
    (set, get) => ({
      sessions: {},
      opening: {},
      setOpening: (scope, update) => set(state => ({ opening: { ...state.opening, [scope]: { ...(state.opening[scope] ?? DEFAULT_WORKSPACE_OPENING), ...update } } })),
      setWorkspaceWidth: (scope, width) => { if (Number.isFinite(width) && width > 0) workspaceWidths.set(scope, width); },
      keepTab: (scope, tabId) => set(state => {
        const session = state.sessions[scope];
        if (!session?.panes.some(pane => pane.previewTabId === tabId)) return state;
        return updateSession(state, scope, { ...session, panes: session.panes.map(pane => pane.previewTabId === tabId ? { ...pane, previewTabId: undefined } : pane) });
      }),
      transcriptArtifactTargets: {},
      readLayout: value => mergePersistedSessions({ sessions: { seed: value } }, get()).sessions.seed ?? null,
      migrateWorkspace: workspaceId => set(state => {
        const key = workspacePanelKey(workspaceId);
        const oldKey = `project:${workspaceId}`;
        const legacy = state.sessions[oldKey];
        if (!legacy) return state;
        let session = state.sessions[key];
        if (!session?.tabs.length) session = legacy;
        else for (const tab of legacy.tabs) session = dockTab(key, session, tab);
        const sessions = { ...state.sessions, [key]: session };
        delete sessions[oldKey];
        return { sessions };
      }),
      updateTabLabel: (scope, tabId, label) => set(state => {
        const session = state.sessions[scope];
        if (!session || !session.tabs.some(tab => tab.id === tabId && tab.label !== label)) return state;
        return updateSession(state, scope, { ...session, tabs: session.tabs.map(tab => tab.id === tabId ? { ...tab, label } : tab) });
      }),
      adoptChat: (scope, sessionId, label, options) => set(state => {
        let session = getWritableSession(state, scope);
        const legacy = state.sessions[sessionId];
        if (legacy && scope !== sessionId) {
          const resolved = legacy.tabs.map(tab => {
            if (tab.type !== "artifact") return tab;
            const value = tab.value ?? state.transcriptArtifactTargets[sessionId]?.find(target => target.id === tab.id)?.value;
            return { ...tab, value, sourceSessionId: sessionId };
          });
          if (!session.tabs.length) session = normalizeSession({ ...legacy, tabs: resolved });
          else for (const tab of resolved) session = dockTab(scope, session, tab);
        }
        const chat = chatPanelTab(sessionId, label);
        // Opening a recent chat in another project must keep that project's
        // geometry. Reuse its chat group (or focused group) instead of splitting.
        const chatPane = session.panes.find(pane => pane.tabIds.some(id => session.tabs.some(tab => tab.id === id && tab.type === "chat")));
        session = openInSession(scope, session, chat, state.opening[scope] ?? DEFAULT_WORKSPACE_OPENING, workspaceWidths.get(scope) ?? 0,
          options?.preserveLayout && session.tabs.length ? chatPane?.id ?? session.focusedPaneId ?? session.panes[0]?.id : undefined);
        const sessions = { ...state.sessions, [scope]: session };
        if (scope !== sessionId) delete sessions[sessionId];
        return { sessions };
      }),
      reconnectWikiTabs: (serverUrl, wikiIds) => set(state => {
        if (!isLoopbackLegalworkServerUrl(serverUrl)) return state;
        const known = new Set(wikiIds);
        const sessions = { ...state.sessions };
        let changed = false;
        for (const [scope, session] of Object.entries(sessions)) {
          const renamed = new Map<string, string>();
          const tabs = session.tabs.map(tab => {
            if (tab.type !== "wiki" && tab.type !== "view") return tab;
            const wikiId = tab.type === "wiki" ? tab.wikiId : tab.owner.kind === "wiki" ? tab.owner.id : null;
            // A desktop restart can change its port. Reconnect only wiki IDs
            // confirmed by the current local server, never remote tabs.
            if (!wikiId || !known.has(wikiId) || tab.serverUrl === serverUrl || !isLoopbackLegalworkServerUrl(tab.serverUrl)) return tab;
            const next = tab.type === "wiki" ? wikiPanelTab(serverUrl, wikiId, tab.location, tab.label) : viewPanelTab(serverUrl, tab, tab.label);
            renamed.set(tab.id, next.id);
            return next;
          });
          if (!renamed.size) continue;
          changed = true;
          sessions[scope] = normalizeSession({ ...session, tabs: [...new Map(tabs.map(tab => [tab.id, tab])).values()],
            activeTabId: session.activeTabId ? renamed.get(session.activeTabId) ?? session.activeTabId : null,
            panes: session.panes.map(pane => ({ ...pane,
              tabIds: [...new Set(pane.tabIds.map(id => renamed.get(id) ?? id))],
              activeTabId: pane.activeTabId ? renamed.get(pane.activeTabId) ?? pane.activeTabId : null,
              previewTabId: pane.previewTabId ? renamed.get(pane.previewTabId) ?? pane.previewTabId : undefined,
            })),
          });
        }
        return changed ? { sessions } : state;
      }),
      updateWikiPaths: (serverUrl, wikiId, path, destination) => set((state) => {
        const sessions: Record<string, SessionPanelState> = {};
        for (const [sessionId, session] of Object.entries(state.sessions)) {
          let activeTabId = session.activeTabId;
          const renamed = new Map<string, string>();
          const tabs: PanelTab[] = [];
          for (const tab of session.tabs) {
            if (tab.type !== "wiki" || tab.serverUrl !== serverUrl || tab.wikiId !== wikiId || (tab.location.kind !== "page" && tab.location.kind !== "asset")
              || (tab.location.path !== path && !tab.location.path.startsWith(`${path}/`))) { tabs.push(tab); continue; }
            if (destination === null) { if (tab.id === activeTabId) activeTabId = null; continue; }
            const nextPath = destination + tab.location.path.slice(path.length);
            const next = wikiPanelTab(serverUrl, wikiId, { ...tab.location, path: nextPath }, nextPath.split("/").at(-1)?.replace(/\.md$/i, "") ?? nextPath);
            renamed.set(tab.id, next.id);
            tabs.push(next);
            if (tab.id === activeTabId) activeTabId = next.id;
          }
          sessions[sessionId] = normalizeSession({ ...session, tabs,
            panes: session.panes.map(pane => ({ ...pane,
              tabIds: pane.tabIds.map(id => renamed.get(id) ?? id),
              activeTabId: pane.activeTabId ? renamed.get(pane.activeTabId) ?? pane.activeTabId : null,
              previewTabId: pane.previewTabId ? renamed.get(pane.previewTabId) ?? pane.previewTabId : undefined,
            })),
            activeTabId: resolveActiveTabId(tabs, activeTabId),
          });
        }
        return { sessions };
      }),
      setStorageWorkingPath: (sessionId, tabId, path) => set((state) => {
        const session = getWritableSession(state, sessionId);
        const tab = session.tabs.find((item) => item.id === tabId);
        if (tab?.type !== "artifact" || !tab.storage || tab.value === path) return state;
        return updateSession(state, sessionId, { ...session, tabs: session.tabs.map((item) => item.id === tabId ? { ...tab, value: path } : item) });
      }),
      openTab: (sessionId, tab, paneId, edge, options) => set(state => {
        const session = getWritableSession(state, sessionId);
        const opening = state.opening[sessionId] ?? DEFAULT_WORKSPACE_OPENING;
        const width = workspaceWidths.get(sessionId) ?? 0;
        const next = openInSession(sessionId, session, tab,
          options?.besideChat ? { ...DEFAULT_WORKSPACE_OPENING, chatSide: opening.chatSide } : opening,
          options?.besideChat ? Math.max(width, MIN_AUTO_SPLIT_WIDTH) : width,
          options?.besideChat ? undefined : paneId, edge, options?.preview,
          () => get().openTab(sessionId, tab, paneId, edge, options));
        return next === session ? state : updateSession(state, sessionId, next);
      }),
      resolveViewTab: (draftId, saved) => set(state => ({ sessions: Object.fromEntries(Object.entries(state.sessions).map(([scope, session]) => {
        if (!session.tabs.some(tab => tab.id === draftId)) return [scope, session];
        const panes = session.panes.map(pane => ({ ...pane,
          tabIds: pane.tabIds.flatMap(id => id === draftId ? [saved.id] : id === saved.id ? [] : [id]),
          activeTabId: pane.activeTabId === draftId ? saved.id : pane.activeTabId === saved.id ? null : pane.activeTabId,
          previewTabId: pane.previewTabId === draftId ? undefined : pane.previewTabId,
        }));
        return [scope, normalizeSession({ ...session, tabs: replaceGenerationTab(session.tabs, draftId, saved), panes })];
      })) })),
      replaceTab: (tabId, replacement) => set(state => {
        const sessions = { ...state.sessions };
        let changed = false;
        for (const [scope, session] of Object.entries(sessions)) {
          if (!session.tabs.some(tab => tab.id === tabId)) continue;
          changed = true;
          const panes = session.panes.map(pane => ({ ...pane,
            tabIds: pane.tabIds.flatMap(id => id === tabId ? [replacement.id] : id === replacement.id ? [] : [id]),
            activeTabId: pane.activeTabId === tabId ? replacement.id : pane.activeTabId === replacement.id ? null : pane.activeTabId,
            previewTabId: pane.previewTabId === tabId || pane.previewTabId === replacement.id ? undefined : pane.previewTabId,
          }));
          sessions[scope] = normalizeSession({ ...session, panes,
            tabs: session.tabs.flatMap(tab => tab.id === tabId ? [replacement] : tab.id === replacement.id ? [] : [tab]),
            activeTabId: session.activeTabId === tabId ? replacement.id : session.activeTabId,
          });
        }
        return changed ? { sessions } : state;
      }),
      finishFileImport: (id, file) => set(state => {
        const sessions = { ...state.sessions };
        let changed = false;
        for (const [scope, session] of Object.entries(sessions)) {
          if (!session.tabs.some(tab => tab.type === "artifact" && tab.pendingImportId === id)) continue;
          changed = true;
          sessions[scope] = { ...session, tabs: session.tabs.map(tab => tab.type === "artifact" && tab.pendingImportId === id
            ? { ...tab, pendingImportId: undefined, value: file.path, preview: classifyOpenTarget(file.path, "file"), size: file.size, updatedAt: file.updatedAt }
            : tab) };
        }
        return changed ? { sessions } : state;
      }),
      closeTab: (sessionId, tabId) => set(state => {
        const session = getWritableSession(state, sessionId);
        const closing = session.tabs.find(tab => tab.id === tabId);
        const pane = session.panes.find(pane => pane.tabIds.includes(tabId));
        if (!closing || !pane) return state;
        if (closing.type === "workflow" || closing.type === "workflow-resource") {
          if (!confirmDiscardSessionDocuments(sessionId, [tabId], undefined, false, () => get().closeTab(sessionId, tabId))) return state;
        } else if ((isWorkspacePanelScope(sessionId) || pane.activeTabId === tabId) && !confirmDiscardSessionDocuments(sessionId, [tabId], undefined, true, () => get().closeTab(sessionId, tabId))) return state;
        return updateSession(state, sessionId, normalizeSession({ ...session, tabs: session.tabs.filter(tab => tab.id !== tabId),
          panes: session.panes.map(entry => entry.id === pane.id ? { ...entry, tabIds: entry.tabIds.filter(id => id !== tabId), activeTabId: entry.activeTabId === tabId ? neighbour(session, entry, tabId) : entry.activeTabId } : entry),
        }));
      }),
      selectTab: (sessionId, tabId) => set(state => {
        const session = getWritableSession(state, sessionId);
        const pane = session.panes.find(pane => pane.tabIds.includes(tabId));
        if (!pane || (pane.activeTabId === tabId && session.focusedPaneId === pane.id) || (pane.activeTabId !== tabId && !isWorkspacePanelScope(sessionId) && !confirmDiscardSessionDocuments(sessionId, [pane.activeTabId], undefined, true, () => get().selectTab(sessionId, tabId)))) return state;
        return updateSession(state, sessionId, normalizeSession({ ...session, focusedPaneId: pane.id, panes: session.panes.map(entry => entry.id === pane.id ? { ...entry, activeTabId: tabId } : entry) }));
      }),
      restoreNavigationTab: (scope, value, paneId) => {
        if (!record(value) || typeof value.id !== "string") return;
        const tab = restoredTab(value);
        const session = get().sessions[scope];
        const existing = session?.tabs.find(entry => entry.id === value.id);
        if (existing) {
          // Keep live editor/browser state. Only wiki heading destinations belong to navigation.
          if (existing.type === "wiki" && tab?.type === "wiki") get().openTab(scope, { ...existing, location: tab.location }, session.panes.find(pane => pane.tabIds.includes(tab.id))?.id);
          else get().selectTab(scope, existing.id);
        } else if (tab && tab.type !== "browser") {
          const pane = session?.panes.find(pane => pane.id === paneId) ?? session?.panes.find(pane => pane.id === session.focusedPaneId) ?? session?.panes[0];
          get().openTab(scope, tab, pane?.id);
        }
      },
      moveTab: (sessionId, tabId, pane, edge) => set(state => {
        const session = getWritableSession(state, sessionId);
        const tab = session.tabs.find(tab => tab.id === tabId);
        if (!tab) return state;
        const next = openInSession(sessionId, session, tab, state.opening[sessionId] ?? DEFAULT_WORKSPACE_OPENING, workspaceWidths.get(sessionId) ?? 0, pane, edge, false, () => get().moveTab(sessionId, tabId, pane, edge));
        return next === session ? state : updateSession(state, sessionId, next);
      }),
      setPaneSizes: (sessionId, layout, sizes) => set(state => {
        const session = getWritableSession(state, sessionId);
        const node = findLayoutNode(session.tree, layout);
        // Ignore delayed resize notifications from a group that just collapsed
        // or whose child was replaced by a new split.
        if (node?.type !== "split" || Object.keys(sizes).length !== 2 ||
          ![node.first.id, node.second.id].every(id => Number.isFinite(sizes[id]) && sizes[id] > 0 && sizes[id] < 100)) return state;
        return updateSession(state, sessionId, { ...session, sizes: { ...session.sizes, [layout]: sizes } });
      }),
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
      syncBrowserTabs: (sessionId, browserTabs, activeBrowserTabId) => {
        latestBrowserStates.set(sessionId, { tabs: browserTabs, activeId: activeBrowserTabId });
        set((state) => {
        const session = getWritableSession(state, sessionId);
        // Native browser state is window-local. A project adopts new tabs but must
        // not import another project's or an Evals session's existing browser tabs.
        const ownedElsewhere = new Set(Object.entries(state.sessions).flatMap(([key, value]) =>
          key !== sessionId ? value.tabs.filter(tab => tab.type === "browser").map(tab => tab.id) : []));
        browserTabs = browserTabs.filter(tab => !tab.background && (!ownedElsewhere.has(tab.id) || session.tabs.some(item => item.id === tab.id)));
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

        const assigned = new Set(session.panes.flatMap(pane => pane.tabIds));
        const added = browserTabs.filter(tab => !assigned.has(tab.id));
        let nextSession = normalizeSession({ ...session, tabs: mergedTabs.filter(tab => !added.some(item => item.id === tab.id)) });
        for (const tab of added) {
          nextSession = openInSession(sessionId, nextSession, tab, state.opening[sessionId] ?? DEFAULT_WORKSPACE_OPENING, workspaceWidths.get(sessionId) ?? 0, undefined, undefined, false, () => {
            const latest = latestBrowserStates.get(sessionId);
            if (latest) get().syncBrowserTabs(sessionId, latest.tabs, latest.activeId);
          });
        }
        if (activeBrowserTabId) {
          const owner = nextSession.panes.find(pane => pane.tabIds.includes(activeBrowserTabId));
          const current = nextSession.tabs.find(tab => tab.id === owner?.activeTabId);
          if (owner && (!current || current.type === "browser")) nextSession = normalizeSession({ ...nextSession,
            panes: nextSession.panes.map(pane => pane.id === owner.id ? { ...pane, activeTabId: activeBrowserTabId } : pane) });
        }

        if (isSameSessionPanelState(session, nextSession)) {
          return state;
        }

        return updateSession(state, sessionId, nextSession);
        });
      },
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
        latestBrowserStates.delete(sessionId);
        workspaceWidths.delete(sessionId);
        const nextSessions = { ...state.sessions };
        const nextTranscriptArtifactTargets = { ...state.transcriptArtifactTargets };
        
        let changed = false;
        for (const [key, session] of Object.entries(nextSessions)) {
          const tabs = session.tabs.filter(tab => tab.type === "chat" ? tab.sessionId !== sessionId : tab.type !== "view-draft" || useViewGenerationStore.getState().entries[tab.generationId]?.sessionId !== sessionId);
          if (tabs.length !== session.tabs.length) {
            nextSessions[key] = normalizeSession({ ...session, tabs });
            changed = true;
          }
        }

        if (state.sessions[sessionId]) {
          delete nextSessions[sessionId];
          changed = true;
        }

        if (state.transcriptArtifactTargets[sessionId]) {
          delete nextTranscriptArtifactTargets[sessionId];
          changed = true;
        }

        useViewGenerationStore.getState().forgetSession(sessionId);
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
        if (typeof window === "undefined") return localStorage;
        // A detached window keeps its own layout even after navigation removes
        // the initial query parameter, including after a renderer reload.
        const detachedKey = "legalwork:panel-window:detached";
        if (window.location.href.includes("detached=1")) sessionStorage.setItem(detachedKey, "1");
        if (!sessionStorage.getItem(detachedKey)) return localStorage;
        return {
          getItem: key => sessionStorage.getItem(key) ?? localStorage.getItem(key),
          setItem: (key, value) => sessionStorage.setItem(key, value),
          removeItem: key => sessionStorage.removeItem(key),
        };
      }),
      partialize: (state) => ({
        opening: state.opening,
        sessions: Object.fromEntries(
          Object.entries(state.sessions).map(([sessionId, session]) => {
            const tabs = session.tabs
              .flatMap<PersistedPanelTab>((tab) => {
                if (tab.type === "recording" || tab.type === "chat" || tab.type === "review" || tab.type === "task" || tab.type === "project-view" || tab.type === "wiki" || tab.type === "view") return [tab];
                // Workflow drafts and their service bindings are in-memory; never restore empty editor stubs.
                if (tab.type === "workflow" || tab.type === "workflow-resource" || tab.type === "view-draft") return [];
                if (tab.type === "browser") return [{ id: tab.id, type: tab.type, background: tab.background }];
                if (tab.type === "artifact" && tab.sourceProject) return [{ ...projectFileTab(tab.sourceProject), id: tab.id }];
                // Restore original workspace files, not downloaded credentials,
                // cached storage working copies or ephemeral evidence viewers.
                if (tab.type === "artifact" && tab.value && !tab.storage && !tab.searchSources && !tab.reviewCitation && !tab.reviewRecognition)
                  return [{ id: tab.id, type: tab.type, label: tab.label, value: tab.value, ...(tab.wikiSuggestion ? { wikiSuggestion: tab.wikiSuggestion } : {}) }];
                return [];
              });

            return [
              sessionId,
              {
                tabs,
                activeTabId: resolveActiveTabId(tabs, session.activeTabId),
                sideTabIds: session.sideTabIds,
                sideActiveTabId: session.sideActiveTabId,
                focusedPaneId: session.focusedPaneId,
                panes: session.panes,
                tree: session.tree,
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

export const usePanelTabStore = createPanelTabStore();

export function useSessionPanelState(sessionId: string): SessionPanelState {
  return usePanelTabStore((state) => state.sessions[sessionId] ?? EMPTY_SESSION);
}

export function useActivePanelTab(sessionId: string): PanelTab | null {
  return usePanelTabStore((state) => {
    const session = state.sessions[sessionId] ?? EMPTY_SESSION;

    const activeId = session.panes.find(pane => pane.id === session.focusedPaneId)?.activeTabId ?? session.activeTabId;
    return session.tabs.find(tab => tab.id === activeId) ?? null;
  });
}
