import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import type { AssistantProfile } from "@legalwork/types/main-assistant";
import { LauncherDesktopEventSchema, LauncherDraftFileSchema, type LauncherDesktopEvent } from "@legalwork/types/launcher";
import { createLegalworkServerClient, type LegalworkServerClient, type LegalworkWorkspaceInfo } from "@/app/lib/legalwork-server";
import { launcherDraftsRead, launcherDraftsWrite, launcherInvocationsDrain, launcherOriginGet, launcherWindowControl } from "@/app/lib/desktop";
import { isDesktopRuntime } from "@/app/lib/runtime-env";
import { parseAssistantDeepLink } from "@/app/lib/assistant-links";
import { t } from "@/i18n";
import { resolveLegalworkConnection } from "@/react-app/shell/legalwork-connection";
import { useSyncEvents } from "@/react-app/kernel/sync-events";
import { DraftCoordinator, EMPTY_DRAFT_FILE, type DraftMessage, type DraftStorage } from "./draft-coordinator";
import { LauncherPanel } from "./launcher-panel";
import { LauncherShellContext, type LauncherShellValue } from "./launcher-shell";
import { useLauncherStore } from "./launcher-store";

const LAUNCHER_EVENT = "legalwork:launcher:event";
const CHANNEL = "legalwork-launcher-drafts";
const DRAFTS_KEY = "legalwork.launcher.drafts.v1";

/** The desktop file is the source of truth; the browser fallback keeps a local copy for the web app only. */
export function createDraftStorage(desktop: boolean): DraftStorage {
  if (desktop) return { read: async () => LauncherDraftFileSchema.parse(await launcherDraftsRead()), write: (file, expectedVersion) => launcherDraftsWrite(file, expectedVersion) };
  const read = async () => { const raw = window.localStorage.getItem(DRAFTS_KEY); return raw ? LauncherDraftFileSchema.parse(JSON.parse(raw)) : structuredClone(EMPTY_DRAFT_FILE); };
  return {
    read,
    write: async (file, expectedVersion) => await navigator.locks.request(DRAFTS_KEY, async () => {
      if ((await read()).version !== expectedVersion) return false;
      window.localStorage.setItem(DRAFTS_KEY, JSON.stringify(file));
      return true;
    }),
  };
}
export function createDraftChannel() {
  if (typeof BroadcastChannel === "undefined") return undefined;
  const channel = new BroadcastChannel(CHANNEL);
  return { post: (message: DraftMessage) => channel.postMessage(message), subscribe: (listener: (message: DraftMessage) => void) => { const handler = (event: MessageEvent<DraftMessage>) => listener(event.data); channel.addEventListener("message", handler); return () => channel.removeEventListener("message", handler); } };
}
let sharedDrafts: DraftCoordinator | null = null;
export function sharedDraftCoordinator() {
  sharedDrafts ??= new DraftCoordinator(createDraftStorage(isDesktopRuntime()), createDraftChannel());
  return sharedDrafts;
}
export function windowOwnerId(prefix: string) {
  try {
    const existing = window.sessionStorage.getItem("legalwork.launcher.owner");
    if (existing) return `${prefix}:${existing}`;
    const id = `${prefix}:${crypto.randomUUID().slice(0, 8)}`;
    window.sessionStorage.setItem("legalwork.launcher.owner", id);
    return `${prefix}:${id}`;
  } catch { return `${prefix}:${crypto.randomUUID().slice(0, 8)}`; }
}

export function useLauncherConnection() {
  const [client, setClient] = useState<LegalworkServerClient | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false, timer: ReturnType<typeof setTimeout> | undefined;
    const resolve = async () => {
      try {
        const connection = await resolveLegalworkConnection();
        if (cancelled) return;
        if (!connection.normalizedBaseUrl || (!connection.resolvedToken && !connection.resolvedHostToken)) { setError(t("launcher.connecting")); timer = setTimeout(resolve, 1500); return; }
        setClient(current => current?.baseUrl === connection.normalizedBaseUrl && current.token === connection.resolvedToken ? current : createLegalworkServerClient({ baseUrl: connection.normalizedBaseUrl, token: connection.resolvedToken || undefined, hostToken: connection.resolvedHostToken || undefined }));
        setError(null);
      } catch (failure) { if (!cancelled) { setError(failure instanceof Error ? failure.message : String(failure)); timer = setTimeout(resolve, 3000); } }
    };
    void resolve();
    const onChange = () => void resolve();
    window.addEventListener("legalwork-server-settings-changed", onChange);
    return () => { cancelled = true; clearTimeout(timer); window.removeEventListener("legalwork-server-settings-changed", onChange); };
  }, []);
  return { client, error };
}

/** The dedicated panel route: the app's connection, theme and i18n, without workspace UI. */
export function LauncherRoute() {
  const { client, error } = useLauncherConnection();
  const navigate = useNavigate();
  const desktop = isDesktopRuntime();
  useLayoutEffect(() => {
    document.documentElement.classList.add("launcher-window");
    return () => document.documentElement.classList.remove("launcher-window");
  }, []);
  const [assistant, setAssistant] = useState<{ workspaceId: string; profile: AssistantProfile } | null>(null);
  const [workspaces, setWorkspaces] = useState<LegalworkWorkspaceInfo[]>([]);
  const drafts = useMemo(() => sharedDraftCoordinator(), []);
  const owner = useMemo(() => windowOwnerId("panel"), []);
  const seen = useRef(new Set<string>());
  useSyncEvents(client);
  const refresh = useCallback(async () => {
    if (!client) return;
    const [current, list] = await Promise.all([client.assistantConversationCurrent(), client.listWorkspaces()]);
    setAssistant(current.workspace ? { workspaceId: current.workspace.id, profile: current.profile } : null);
    setWorkspaces((list.items ?? list.workspaces ?? []).filter(workspace => workspace.preset !== "main-assistant" && workspace.preset !== "wiki"));
  }, [client]);
  useEffect(() => { void refresh().catch(() => undefined); }, [refresh]);
  useEffect(() => { void drafts.ready(); }, [drafts]);
  // Desktop events: invocations, visibility, origin and attention. Invocation IDs deduplicate repeated delivery.
  useEffect(() => {
    if (!desktop) return;
    const apply = (event: LauncherDesktopEvent) => {
      const store = useLauncherStore.getState();
      if (event.type === "invocation") {
        if (seen.current.has(event.invocation.id)) return;
        seen.current.add(event.invocation.id);
        if (client) void client.registerLauncherInvocation(event.invocation).then(result => { if (!result.duplicate) store.setInvocation(event.invocation); }).catch(() => store.setInvocation(event.invocation));
        else store.setInvocation(event.invocation);
      } else if (event.type === "visibility") { store.setVisible(event.visible); store.setPinned(event.pinned); if (!event.visible) store.reset(); }
      else if (event.type === "position") store.setPositionMoved(event.moved);
      else if (event.type === "origin") store.setOrigin(event.origin);
      else if (event.type === "attention") store.setAttentionCount(event.count);
      else if (event.type === "approval") store.setApproval(event.request);
      else if (event.type === "approval-closed") { if (store.approval?.id === event.id) store.setApproval(null); }
      else if (event.type === "voice") store.setVoice(event.voice);
    };
    const listener = (event: Event) => { if (!(event instanceof CustomEvent)) return; const parsed = LauncherDesktopEventSchema.safeParse(event.detail); if (parsed.success) apply(parsed.data); };
    window.addEventListener(LAUNCHER_EVENT, listener);
    void launcherInvocationsDrain().then(invocations => invocations.forEach(invocation => apply({ type: "invocation", invocation }))).catch(() => undefined);
    void launcherOriginGet().then(origin => useLauncherStore.getState().setOrigin(origin)).catch(() => undefined);
    void launcherWindowControl("state").then(state => useLauncherStore.getState().setPositionMoved(state.moved)).catch(() => undefined);
    return () => window.removeEventListener(LAUNCHER_EVENT, listener);
  }, [desktop, client]);
  // Deep links reaching this window directly (web): the same invocation contract.
  useEffect(() => {
    // On the web the launcher route takes `?action=ask&q=…`; the desktop delivers links through the service.
    const url = new URL(window.location.href);
    const action = url.searchParams.get("action");
    const invocation = action ? parseAssistantDeepLink(`legalwork://assistant/${encodeURIComponent(action)}?${url.searchParams}`) : null;
    if (invocation && !seen.current.has(invocation.id)) { seen.current.add(invocation.id); useLauncherStore.getState().setInvocation(invocation); }
  }, []);
  const shell = useMemo<LauncherShellValue | null>(() => client ? {
    client, assistant, workspaces, drafts, owner, surface: "panel", conversationId: null, desktop,
    openInApp: route => { if (desktop) void launcherWindowControl("expand", { route }); else navigate(route); },
    dismiss: () => { if (desktop) void launcherWindowControl("hide"); else navigate("/home"); },
    refresh,
  } : null, [client, assistant, workspaces, drafts, owner, desktop, navigate, refresh]);
  if (!shell) return <div className="launcher-root" data-surface="panel"><div className="launcher-panel"><div className="launcher-empty"><Loader2 className="mx-auto mb-2 size-5 animate-spin motion-reduce:animate-none" />{error ?? t("launcher.connecting")}</div></div></div>;
  return <LauncherShellContext.Provider value={shell}><LauncherPanel /></LauncherShellContext.Provider>;
}
