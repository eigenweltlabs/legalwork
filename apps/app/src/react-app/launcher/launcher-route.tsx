import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useBootState } from "@/react-app/shell/boot-state";
import { launcherBootstrapQueries } from "./launcher-bootstrap";
import { useNavigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { LauncherDesktopEventSchema, type LauncherDesktopEvent } from "@legalwork/types/launcher";
import { createLegalworkServerClient, LEGALWORK_DRAFT_ACCOUNT_EVENT, resolveLauncherDraftAccount, type LegalworkServerClient } from "@/app/lib/legalwork-server";
import { launcherDraftsRead, launcherDraftsWrite, launcherInvocationsDrain, launcherOriginGet, launcherWindowControl } from "@/app/lib/desktop";
import { isDesktopRuntime } from "@/app/lib/runtime-env";
import { parseAssistantDeepLink } from "@/app/lib/assistant-links";
import { t } from "@/i18n";
import { resolveLegalworkConnection } from "@/react-app/shell/legalwork-connection";
import { useSyncEvents } from "@/react-app/kernel/sync-events";
import { hashDraftProfile } from "./draft-profile";
import { DraftCoordinator, EMPTY_DRAFT_FILE, readDraftFile, type DraftFile, type DraftStorage } from "./draft-coordinator";
import { LauncherPanel } from "./launcher-panel";
import { LauncherShellContext, type LauncherShellValue } from "./launcher-shell";
import { useLauncherStore } from "./launcher-store";

const LAUNCHER_EVENT = "legalwork:launcher:event";
function browserDraftStorage(profile: string): DraftStorage {
  const database = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("legalwork-launcher-drafts", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("profiles");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return {
    read: async () => {
      const db = await database;
      return new Promise<DraftFile>((resolve, reject) => {
        const request = db.transaction("profiles").objectStore("profiles").get(profile);
        request.onsuccess = () => { try { resolve(readDraftFile(request.result ?? EMPTY_DRAFT_FILE)); } catch (error) { reject(error); } };
        request.onerror = () => reject(request.error);
      });
    },
    write: async (file, version) => {
      const db = await database;
      return new Promise<boolean>((resolve, reject) => {
        const tx = db.transaction("profiles", "readwrite"), store = tx.objectStore("profiles"), current = store.get(profile);
        let accepted = false;
        current.onsuccess = () => { if ((current.result?.version ?? 0) === version) { store.put(file, profile); accepted = true; } };
        tx.oncomplete = () => resolve(accepted);
        tx.onabort = () => reject(tx.error ?? new Error("Draft storage unavailable"));
      });
    },
  };
}

const coordinators = new Map<string, DraftCoordinator>();
export function sharedDraftCoordinator(client: Pick<LegalworkServerClient, "draftProfile"> | null) {
  const key = client?.draftProfile ?? "disconnected";
  const existing = coordinators.get(key);
  if (existing) return existing;
  const profile = hashDraftProfile(key);
  const storage = profile.then((id): DraftStorage => isDesktopRuntime() ? {
    read: async () => readDraftFile(await launcherDraftsRead(id)),
    write: (file, version) => launcherDraftsWrite(file, version, id),
  } : browserDraftStorage(id));
  const channel = profile.then(id => typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("legalwork-launcher-drafts:" + id));
  const coordinator = new DraftCoordinator({
    read: async () => (await storage).read(),
    write: async (file, version) => {
      const written = await (await storage).write(file, version);
      if (written) (await channel)?.postMessage("updated");
      return written;
    },
  });
  // Notify other windows to reread. Never broadcast large attachments or credentials.
  void channel.then(bus => { if (bus) bus.onmessage = () => { void coordinator.reconcile().catch(() => undefined); }; });
  coordinators.set(key, coordinator);
  return coordinator;
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
  const connectionKey = useRef("");
  const draftProfile = useRef<string | null>(null);
  const profileGeneration = useRef(0);
  const changeClient = (next: LegalworkServerClient | null) => {
    const profile = next?.draftProfile ?? null;
    if (draftProfile.current && draftProfile.current !== profile) {
      const { visible, pinned, positionMoved, origin } = useLauncherStore.getState();
      useLauncherStore.setState({ ...useLauncherStore.getInitialState(), visible, pinned, positionMoved, origin });
    }
    if (draftProfile.current !== profile) profileGeneration.current++;
    draftProfile.current = profile;
    setClient(next);
  };
  useEffect(() => {
    let generation = 0;
    let cancelled = false, timer: ReturnType<typeof setTimeout> | undefined;
    const resolve = async () => {
      const currentGeneration = ++generation;
      clearTimeout(timer);
      try {
        const connection = await resolveLegalworkConnection();
        if (cancelled || generation !== currentGeneration) return;
        if (!connection.normalizedBaseUrl || (!connection.resolvedToken && !connection.resolvedHostToken)) { connectionKey.current = ""; changeClient(null); setError(t("launcher.connecting")); timer = setTimeout(resolve, 1500); return; }
        const options = { baseUrl: connection.normalizedBaseUrl, token: connection.resolvedToken || undefined, hostToken: connection.resolvedHostToken || undefined, managedDesktop: connection.source === "desktop-runtime" };
        const draftAccount = await resolveLauncherDraftAccount(options);
        if (cancelled || generation !== currentGeneration) return;
        const clientOptions = { ...options, draftAccount };
        const key = JSON.stringify(clientOptions);
        if (connectionKey.current !== key) {
          connectionKey.current = key;
          changeClient(createLegalworkServerClient(clientOptions));
        }
        setError(null);
      } catch (failure) { if (!cancelled && generation === currentGeneration) { setError(failure instanceof Error ? failure.message : String(failure)); timer = setTimeout(resolve, 3000); } }
    };
    void resolve();
    const onChange = () => void resolve();
    window.addEventListener("legalwork-server-settings-changed", onChange);
    const onAccountStorage = (event: StorageEvent) => { if (event.key === LEGALWORK_DRAFT_ACCOUNT_EVENT) onChange(); };
    window.addEventListener("focus", onChange);
    window.addEventListener(LEGALWORK_DRAFT_ACCOUNT_EVENT, onChange);
    window.addEventListener("storage", onAccountStorage);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener("legalwork-server-settings-changed", onChange);
      window.removeEventListener("focus", onChange);
      window.removeEventListener(LEGALWORK_DRAFT_ACCOUNT_EVENT, onChange);
      window.removeEventListener("storage", onAccountStorage);
    };
  }, []);
  return { client, error, profileGeneration: profileGeneration.current };
}

/** The dedicated panel route: the app's connection, theme and i18n, without workspace UI. */
export function LauncherRoute() {
  const { client, error, profileGeneration } = useLauncherConnection();
  const { markRouteReady } = useBootState();
  // This independent window has no SessionRoute to release the global boot overlay.
  useEffect(() => { markRouteReady(); }, [markRouteReady]);
  const navigate = useNavigate();
  const desktop = isDesktopRuntime();
  useLayoutEffect(() => {
    document.documentElement.classList.add("launcher-window");
    return () => document.documentElement.classList.remove("launcher-window");
  }, []);
  const queries = launcherBootstrapQueries(client);
  const assistantQuery = useQuery(queries.assistant);
  const workspaceQuery = useQuery(queries.workspaces);
  const assistant = useMemo(() => assistantQuery.data?.workspace
    ? { workspaceId: assistantQuery.data.workspace.id, profile: assistantQuery.data.profile } : null, [assistantQuery.data]);
  const workspaces = useMemo(() => workspaceQuery.data ?? [], [workspaceQuery.data]);
  const bootstrapError = workspaceQuery.error?.message ?? assistantQuery.error?.message ?? null;
  const drafts = useMemo(() => sharedDraftCoordinator(client), [client]);
  const owner = useMemo(() => windowOwnerId("panel"), []);
  const seen = useRef(new Set<string>());
  const deliveryRevision = useRef(0);
  useSyncEvents(client);
  const refresh = useCallback(async () => { await Promise.all([assistantQuery.refetch(), workspaceQuery.refetch()]); }, [assistantQuery.refetch, workspaceQuery.refetch]);
  useEffect(() => { void drafts.ready().catch(failure => useLauncherStore.getState().notify({ tone: "error", text: failure instanceof Error ? failure.message : String(failure) })); }, [drafts]);
  // Desktop events: invocations, visibility, origin and attention. Invocation IDs deduplicate repeated delivery.
  useEffect(() => {
    if (!desktop) return;
    let cancelled = false, stateRevision = 0, originRevision = 0;
    const apply = (event: LauncherDesktopEvent) => {
      const store = useLauncherStore.getState();
      if (event.type === "invocation") {
        if (seen.current.has(event.invocation.id)) return;
        seen.current.add(event.invocation.id);
        const revision = ++deliveryRevision.current;
        const deliver = () => { if (!cancelled && deliveryRevision.current === revision) store.setInvocation(event.invocation); };
        // Native delivery and the single-use handoff already deduplicate external
        // links. Never post their contents to the panel's configured server.
        if (event.invocation.source === "raycast" || event.invocation.source === "deep-link" ||
          (event.invocation.action === "open" && !event.invocation.result && !event.invocation.contextId && !event.invocation.conversationId && !event.invocation.projectId)) {
          deliver();
        } else if (client) void client.registerLauncherInvocation({ ...event.invocation, workspaceContext: event.invocation.workspaceContext ? { ...event.invocation.workspaceContext, dashboard: undefined } : undefined }).then(result => { if (!result.duplicate) deliver(); }).catch(deliver);
        else deliver();
      } else if (event.type === "visibility") { stateRevision++; store.setVisible(event.visible); store.setPinned(event.pinned); if (!event.visible) { deliveryRevision.current++; store.setInvocation(null); store.reset(); } }
      else if (event.type === "position") { stateRevision++; store.setPositionMoved(event.moved); }
      else if (event.type === "origin") { originRevision++; store.setOrigin(event.origin); }
      else if (event.type === "attention") store.setAttentionCount(event.count);
      else if (event.type === "approval") store.setApproval(event.request);
      else if (event.type === "approval-closed") { if (store.approval?.id === event.id) store.setApproval(null); }
      else if (event.type === "voice") store.setVoice(event.voice);
    };
    const listener = (event: Event) => { if (!(event instanceof CustomEvent)) return; const parsed = LauncherDesktopEventSchema.safeParse(event.detail); if (parsed.success) apply(parsed.data); };
    window.addEventListener(LAUNCHER_EVENT, listener);
    void Promise.allSettled([
      launcherOriginGet().then(origin => { if (!cancelled && originRevision === 0) useLauncherStore.getState().setOrigin(origin); }),
      launcherWindowControl("state").then(state => {
        if (cancelled || stateRevision !== 0) return;
        const store = useLauncherStore.getState();
        store.setVisible(state.visible); store.setPinned(state.pinned); store.setPositionMoved(state.moved);
      }),
    ]).then(async () => {
      if (cancelled || !client) return;
      const pending = await launcherInvocationsDrain();
      if (!cancelled) pending.forEach(invocation => apply({ type: "invocation", invocation }));
    }).catch(() => undefined);
    return () => { cancelled = true; window.removeEventListener(LAUNCHER_EVENT, listener); };
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
    openInApp: async route => { if (desktop) await launcherWindowControl("expand", { route }); else navigate(route); },
    dismiss: () => { if (desktop) void launcherWindowControl("hide"); else navigate("/home"); },
    refresh, bootstrapError, workspacesPending: workspaceQuery.isPending,
  } : null, [client, assistant, workspaces, drafts, owner, desktop, navigate, refresh, bootstrapError, workspaceQuery.isPending]);
  if (!shell) return <div className="launcher-root" data-surface="panel"><div className="launcher-panel"><div className="launcher-empty"><Loader2 className="mx-auto mb-2 size-5 animate-spin motion-reduce:animate-none" />{error ?? t("launcher.connecting")}</div></div></div>;
  return <LauncherShellContext.Provider value={shell}><LauncherPanel key={profileGeneration} /></LauncherShellContext.Provider>;
}
