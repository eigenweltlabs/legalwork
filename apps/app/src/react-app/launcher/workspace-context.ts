import { workspaceContextSnapshot } from "./workspace-context-model";
import { useEffect, useRef } from "react";
import type { LauncherWorkspaceContext } from "@legalwork/types/launcher";
import { launcherWindowControl } from "@/app/lib/desktop";
import { isDesktopRuntime } from "@/app/lib/runtime-env";
import { usePanelTabStore, workspacePanelKey } from "@/react-app/domains/session/panel/panel-tab-store";
import { launcherFolderForWorkspace } from "@/react-app/domains/session/panel/workspace-files-panel";
import { rememberLauncherOpen } from "./launcher-recents";

const lastDocument = new Map<string, string | null>();
export function readWorkspaceContext(workspace: { id: string; name: string } | null): LauncherWorkspaceContext | null {
  if (!workspace) return null;
  const result = workspaceContextSnapshot({ workspace, panel: usePanelTabStore.getState().sessions[workspacePanelKey(workspace.id)], folder: launcherFolderForWorkspace(workspace.id), selection: window.getSelection()?.toString(), lastDocumentId: lastDocument.get(workspace.id), now: Date.now() });
  lastDocument.set(workspace.id, result.documentId);
  return result.context;
}

/** Publish only this window's state. The desktop chooses the focused window at invocation. */
export function usePublishLauncherContext(workspace: { id: string; name: string } | null, server = "") {
  const latest = useRef(workspace);
  const lastOpened = useRef("");
  latest.current = workspace;
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    const publish = () => {
      if (!document.hasFocus()) return;
      const context = readWorkspaceContext(latest.current);
      void launcherWindowControl("context", { context }).catch(() => undefined);
      if (!context || !server) { lastOpened.current = ""; return; }
      const file = context.sessionId ? undefined : context.document;
      const sessionTitle = usePanelTabStore.getState().sessions[workspacePanelKey(context.workspaceId)]?.tabs.find(tab => tab.type === "chat" && tab.sessionId === context.sessionId)?.label;
      const id = `${server}:${context.workspaceId}:${file?.path ?? context.sessionId ?? "project"}`;
      if (lastOpened.current === id) return;
      lastOpened.current = id;
      const workspaceId = file?.workspaceId ?? context.workspaceId;
      rememberLauncherOpen(server, { id: file?.path ?? context.sessionId ?? workspaceId, kind: file ? "files" : context.sessionId ? "chats" : "projects", workspaceId,
        sourceId: `local:${workspaceId}`, title: file?.name ?? sessionTitle ?? context.workspaceName, subtitle: file || context.sessionId ? context.workspaceName : undefined,
        path: file?.path, sessionId: context.sessionId, updatedAt: Date.now(), match: "recent", score: 0, actions: ["open"] });
    };
    publish();
    const unsubscribe = usePanelTabStore.subscribe(publish);
    window.addEventListener("focus", publish);
    document.addEventListener("selectionchange", publish);
    window.addEventListener("legalwork:folder-changed", publish);
    return () => { unsubscribe(); window.removeEventListener("focus", publish); document.removeEventListener("selectionchange", publish); window.removeEventListener("legalwork:folder-changed", publish); };
  }, [workspace?.id, workspace?.name, server]);
}
