import { useTaskBrowserTabs } from "../background/task-browser-tabs";
import { openBackgroundTab } from "../background/open-background-tab";
import { useSessionActivityStore } from "../status/session-activity-store";
import { usePanelTabStore, workspacePanelKey } from "../panel/panel-tab-store";
import { resolveDocumentProject } from "./document-project";
import { createDocumentRuntime, documentKey, stringArg, type Entry, type DocumentProject } from "./document-runtime-store";
import { useLocation, useNavigate } from "react-router-dom";
import { createContext, use, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal, flushSync } from "react-dom";
import { ControlActionScope, useControlAction, useControlScope, type LegalworkControlAction, type LegalworkControlSurface } from "../../../shell/control/control-provider";
import { DocumentControlSessions, useDocumentControlSessions } from "../../../shell/control/document-control-sessions";
import { ArtifactPanelContent, type ArtifactPanelProps } from "./artifact-panel";
import { PanelTabDestinationProvider } from "../panel/panel-tab-destination";

async function browserContext(project: DocumentProject, sessionId: string) {
  const browser = window.__LEGALWORK_ELECTRON__?.browser;
  const registration = project.client.token ? await browser?.registerConnection?.({ baseUrl: project.client.baseUrl, token: project.client.token }) : undefined;
  return { workspaceId: project.workspaceId, sessionId, directory: project.workspaceRoot, ...(registration ? { connectionId: registration.connectionId } : {}) };
}

type Runtime = ReturnType<typeof createDocumentRuntime>;
const RuntimeContext = createContext<Runtime | null>(null);
export function useDocumentRuntime() { return use(RuntimeContext); }
const EntryContext = createContext<Entry | null>(null);
export function useDocumentRuntimeEntry() { return use(EntryContext); }
const subscribeEmpty = () => () => {};
const zero = () => 0;
export function useDocumentTaskActive() {
  const runtime = useDocumentRuntime();
  useSyncExternalStore(runtime?.subscribe ?? subscribeEmpty, runtime?.version ?? zero);
  return Boolean(use(EntryContext)?.tasks.size);
}
const DocumentVisibilityContext = createContext(true);
export function useDocumentVisibility() { return use(DocumentVisibilityContext); }


export function DocumentRuntimeProvider({ children }: { children: ReactNode }) {
  const [runtime] = useState(() => createDocumentRuntime(undefined, resolveDocumentProject, flushSync));
  const navigate = useNavigate();
  const location = useLocation();
  useControlAction({ id: "session.open", label: "Open a session", background: true, requiresArgs: true, args: [{ name: "sessionId", type: "string", required: true }], execute: (args, { callerSessionId }) => runtime.openSession(args, callerSessionId, navigate) });
  useControlAction({ id: "session.read_transcript", label: "Read a session transcript", background: true, args: [{ name: "sessionId", type: "string" }, { name: "count", type: "number" }], execute: async (args, { callerSessionId }) => {
    const sessionId = stringArg(args, "sessionId") || (callerSessionId ? runtime.taskSessions.get(callerSessionId) ?? callerSessionId : location.pathname.match(/\/session\/([^/]+)/)?.[1] ?? "");
    const project = await runtime.getProject(sessionId);
    const requested: unknown = args && typeof args === "object" ? Reflect.get(args, "count") : undefined;
    const count = typeof requested === "number" && Number.isFinite(requested) ? Math.min(30, Math.max(1, Math.floor(requested))) : 10;
    const { items } = await project.client.getSessionMessages(project.workspaceId, sessionId, { limit: count });
    return { ok: true, sessionId, returned: items.length, messages: items.map(item => ({ role: item.info.role, parts: item.parts })) };
  } });
  useSyncExternalStore(runtime.subscribe, runtime.version);
  const [parking, setParking] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const tabs = usePanelTabStore.subscribe(() => runtime.prune());
    const attach = (sessionId: string) => void runtime.getProject(sessionId).then(async project =>
      window.__LEGALWORK_ELECTRON__?.browser?.attachSession?.(await browserContext(project, sessionId))).catch(() => {});
    const activity = useSessionActivityStore.subscribe((state, previous) => {
      for (const records of Object.values(state.recordsByWorkspaceId)) for (const [sessionId, record] of Object.entries(records)) {
        if (record.runActive && !Object.values(previous.recordsByWorkspaceId).some(prior => prior[sessionId]?.runActive)) attach(sessionId);
      }
      for (const [workspace, records] of Object.entries(previous.recordsByWorkspaceId)) {
        for (const [sessionId, record] of Object.entries(records)) {
          if (record.runActive && !state.recordsByWorkspaceId[workspace]?.[sessionId]?.runActive) {
            runtime.releaseTask(sessionId);
            void window.__LEGALWORK_ELECTRON__?.browser?.releaseSession?.(sessionId);
          }
        }
      }
    });
    return () => { tabs(); activity(); };
  }, [runtime]);
  useEffect(() => {
    const browser = window.__LEGALWORK_ELECTRON__?.browser;
    const update = (state: import("@/app/lib/desktop").BrowserStatePayload) => {
      useTaskBrowserTabs.getState().update(state.tabs ?? []);
      const focused = state.focusedTabId ? state.tabs?.find(tab => tab.id === state.focusedTabId) : undefined;
      if (focused?.taskSessionId && focused.workspaceId) openBackgroundTab(workspacePanelKey(focused.workspaceId), focused.taskSessionId, { ...focused, background: false });
    };
    const unsubscribe = browser?.onStateChange?.(update);
    void browser?.getState?.().then(state => { if (state) update(state); });
    return unsubscribe;
  }, []);
  useEffect(() => {
    const sessionId = location.pathname.match(/\/session\/([^/]+)/)?.[1];
    if (!sessionId) return;
    void runtime.getProject(sessionId).then(async project => window.__LEGALWORK_ELECTRON__?.browser?.attachSession?.({ ...await browserContext(project, sessionId), takeControl: true })).catch(() => {});
  }, [runtime, location.pathname]);
  useControlAction({ id: "browser.connection", label: "Access a task browser's extended capabilities", background: true, execute: async (args, { callerSessionId }) => {
    const browser = window.__LEGALWORK_ELECTRON__?.browser;
    if (!browser?.connection) throw new Error("The built-in browser is unavailable.");
    const sessionId = callerSessionId || stringArg(args, "sessionId"), project = await runtime.getProject(sessionId);
    return browser.connection(stringArg(args, "tabId"), await browserContext(project, sessionId));
  } });
  useControlAction({ id: "browser.open_url", label: "Open a task browser", background: true, execute: async (args, { callerSessionId }) => {
    const directory = stringArg(args, "directory"), url = stringArg(args, "url");
    if (!directory || !url) throw new Error("A URL and originating project directory are required.");
    const provider = stringArg(args, "provider") || "builtin";
    if (provider !== "auto" && provider !== "builtin") throw new Error("This browser provider is unavailable.");
    const browser = window.__LEGALWORK_ELECTRON__?.browser;
    if (!browser?.openUrl) throw new Error("The built-in browser is unavailable.");
    const sessionId = callerSessionId || stringArg(args, "sessionId"), project = await runtime.getProject(sessionId);
    const result = await browser.openUrl(url, provider, await browserContext(project, sessionId));
    const show = Boolean(args && typeof args === "object" && Reflect.get(args, "show") === true);
    const tab = show ? (await browser.getState?.())?.tabs?.find(item => item.id === result.tab_id) : undefined;
    // Same as the user opening the task's card: the tab moves beside the chat and outlives the run.
    if (tab) openBackgroundTab(workspacePanelKey(stringArg(args, "workspaceId")), stringArg(args, "sessionId"), { ...tab, background: false });
    return result;
  } });
  useControlAction({ id: "browser.set_proxy", label: "Set the task browser proxy", background: true, execute: async (args, { callerSessionId }) => {
    const browser = window.__LEGALWORK_ELECTRON__?.browser;
    if (!browser?.setProxy) throw new Error("The built-in browser is unavailable.");
    const sessionId = callerSessionId || stringArg(args, "sessionId"), project = await runtime.getProject(sessionId);
    return browser.setProxy(stringArg(args, "proxy"), await browserContext(project, sessionId));
  } });
  useControlAction({ id: "markdown.create", label: "Create a Markdown document", background: true, execute: runtime.createMarkdown });
  useControlAction({ id: "documents.open", label: "Prepare a document for a task", background: true, execute: (args, helpers) => runtime.open(args, helpers) });
  useControlAction({ id: "documents.select_open", label: "Select a task document", background: true, execute: runtime.select });
  useControlAction({ id: "documents.begin_file_edit", label: "Save editors before file editing", background: true, execute: (args, helpers) => runtime.beginFileEdit(args, helpers) });
  useControlAction({ id: "documents.end_file_edit", label: "Reload editors after file editing", background: true, execute: runtime.endFileEdit });
  useControlAction({ id: "documents.list", label: "List task documents", background: true, execute: runtime.list });
  useControlAction({ id: "document.agent_tool", label: "Work on a Word document", background: true, execute: (args, helpers) => runtime.execute("document.agent_tool", args, helpers) });
  useControlAction({ id: "office.agent_tool", label: "Work on an Office document", background: true, execute: (args, helpers) => runtime.execute("office.agent_tool", args, helpers) });
  useControlAction({ id: "markdown.agent_tool", label: "Work on a Markdown document", background: true, execute: (args, helpers) => runtime.execute("markdown.agent_tool", args, helpers) });
  return <RuntimeContext value={runtime}>{children}
    <div ref={setParking} inert aria-hidden="true" style={{ position: "fixed", left: -100000, top: 0, width: 1200, height: 900, pointerEvents: "none" }} />
    {[...runtime.entries.values()].map(entry => <RuntimeDocument key={entry.key} entry={entry} runtime={runtime} parking={parking} />)}
  </RuntimeContext>;
}

function RuntimeDocument({ entry, runtime, parking }: { entry: Entry; runtime: Runtime; parking: HTMLElement | null }) {
  const sessionIds = useMemo(() => [entry.props.sessionId, ...entry.sessions], [entry, entry.sessions.size]);
  const destination = [...entry.destinations.keys()].find(node => node.isConnected) ?? null;
  const active = destination ? entry.destinations.get(destination) === true : false;
  useLayoutEffect(() => {
    // A returning route's destination may still be detached during render.
    // Resolve it after React commits, otherwise the editor stays parked until
    // an unrelated runtime update happens to render this component again.
    const committedDestination = [...entry.destinations.keys()].find(node => node.isConnected) ?? null;
    const parent = committedDestination ?? [...entry.previews].find(node => node.isConnected) ?? parking;
    if (committedDestination !== destination) runtime.changed();
    if (!parent || entry.host.parentElement === parent) return;
    if (entry.host.isConnected && parent.isConnected && "moveBefore" in parent && typeof parent.moveBefore === "function") parent.moveBefore(entry.host, null);
    else parent.appendChild(entry.host);
  });
  useLayoutEffect(() => () => entry.host.remove(), [entry]);
  return createPortal(<DocumentVisibilityContext value={Boolean(destination)}><EntryContext value={entry}><DocumentControlSessions sessionIds={sessionIds}>
    <ControlActionScope active={active}>
      <PanelTabDestinationProvider destination={{ kind: "workspace", workspaceId: entry.props.sessionId.replace(/^workspace:/, "") }}>
        {entry.fileEditing ? <div role="status" className="flex h-full items-center justify-center text-sm text-muted-foreground">{entry.props.tab.label}</div> : <ArtifactPanelContent key={entry.generation} {...entry.props} onClose={() => {
          usePanelTabStore.getState().closeTab(entry.props.sessionId, entry.props.tab.id);
          runtime.prune();
        }} />}
      </PanelTabDestinationProvider>
    </ControlActionScope>
  </DocumentControlSessions></EntryContext></DocumentVisibilityContext>, entry.host);
}

/** The viewer is only a destination for a persistent editor, never its owner. */
export function PersistentArtifactPanel(props: ArtifactPanelProps) {
  const runtime = use(RuntimeContext);
  const [destination, setDestination] = useState<HTMLDivElement | null>(null);
  const active = useControlScope();
  const sessions = useDocumentControlSessions(props.sessionId);
  const key = documentKey(props);
  const latest = useRef(props); latest.current = props;
  useLayoutEffect(() => {
    if (!runtime || !destination) return;
    const entry = runtime.ensure(latest.current);
    sessions.forEach(session => entry.sessions.add(session));
    entry.destinations.set(destination, active);
    runtime.changed();
    return () => { entry.destinations.delete(destination); runtime.changed(); runtime.prune(); };
  }, [runtime, key, destination, active, sessions]);
  if (!runtime) return <ArtifactPanelContent {...props} />;
  return <div ref={setDestination} className="h-full min-h-0 min-w-0" />;
}

export function useDocumentProjectResolver(resolve: (sessionId: string) => DocumentProject) {
  const runtime = use(RuntimeContext);
  // Keep the last resolver available while settings or another route is open.
  useLayoutEffect(() => { runtime?.setResolver(resolve); }, [runtime, resolve]);
}

export function useDocumentAgentControl(surface: LegalworkControlSurface | null, action: LegalworkControlAction | null, ready: () => boolean, dirty: () => boolean, updatedAt?: () => number | null) {
  const entry = use(EntryContext);
  const runtime = use(RuntimeContext);
  const latest = useRef({ surface, action, ready, dirty, updatedAt }); latest.current = { surface, action, ready, dirty, updatedAt };
  useLayoutEffect(() => {
    if (!entry || !surface || !action) return;
    const registration = { surface, action, ready: () => latest.current.ready(), dirty: () => latest.current.dirty(), updatedAt: () => latest.current.updatedAt?.() ?? null };
    entry.registration = registration;
    return () => { if (entry.registration === registration) entry.registration = null; };
  }, [entry, surface, action, runtime]);
  useControlAction(entry ? null : action);
}

/** A read-only miniature of the same editor. Promotion moves its host, never reloads it. */
export function DocumentMiniPreview({ entry }: { entry: Entry }) {
  const runtime = useDocumentRuntime();
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!node || !runtime) return;
    entry.previews.add(node); runtime.changed();
    return () => { entry.previews.delete(node); runtime.changed(); };
  }, [entry, node, runtime]);
  return <div inert aria-hidden="true" className="pointer-events-none h-[650px] w-[1000px] origin-top-left scale-[0.22]" ref={setNode} />;
}
