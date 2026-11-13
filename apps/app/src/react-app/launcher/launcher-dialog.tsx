import { launcherWindowControl } from "@/app/lib/desktop";
import { readWorkspaceContext } from "./workspace-context";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { AssistantProfile } from "@legalwork/types/main-assistant";
import type { LegalworkServerClient, LegalworkWorkspaceInfo } from "@/app/lib/legalwork-server";
import { CommandDialog, CommandDialogPopup, CommandDialogTitle } from "@/components/ui/command";
import { isDesktopRuntime } from "@/app/lib/runtime-env";
import { t } from "@/i18n";
import { LauncherPanel } from "./launcher-panel";
import { sharedDraftCoordinator, windowOwnerId } from "./launcher-route";
import { LauncherShellContext, type LauncherShellValue } from "./launcher-shell";
import { useLauncherStore } from "./launcher-store";
import "@/react-app/shell/command-palette.css";

/** The same panel inside the main window (Cmd/Ctrl+K): identical results, actions and conversation. */
export function LauncherDialog(props: { workspace?: { id: string; name: string } | null; open: boolean; onClose: () => void; client: LegalworkServerClient; assistant: { workspaceId: string; profile: AssistantProfile } | null; workspaces: LegalworkWorkspaceInfo[]; conversationId: string | null }) {
  const navigate = useNavigate();
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; startX: number; startY: number } | null>(null);
  useEffect(() => { const reset = () => setOffset({ x: 0, y: 0 }); window.addEventListener("legalwork:launcher-reset-position", reset); window.addEventListener("resize", reset); return () => { window.removeEventListener("legalwork:launcher-reset-position", reset); window.removeEventListener("resize", reset); }; }, []);
  useEffect(() => { useLauncherStore.getState().setPositionMoved(offset.x !== 0 || offset.y !== 0); }, [offset.x, offset.y]);
  const drafts = useMemo(() => sharedDraftCoordinator(), []);
  const owner = useMemo(() => windowOwnerId("main"), []);
  useEffect(() => {
    if (isDesktopRuntime()) {
      if (props.open) void launcherWindowControl("invoke", { context: readWorkspaceContext(props.workspace ?? null) }).then(props.onClose).catch(error => useLauncherStore.getState().notify({ tone: "error", text: String(error) }));
      return;
    }
    if (props.open) useLauncherStore.getState().setVisible(true);
    if (props.open) useLauncherStore.getState().setInvocation({ id: crypto.randomUUID(), action: "open", source: "home", workspaceContext: readWorkspaceContext(props.workspace ?? null) ?? undefined });
  }, [props.open]);
  const shell = useMemo<LauncherShellValue>(() => ({
    client: props.client, assistant: props.assistant, workspaces: props.workspaces, drafts, owner, surface: "embedded", conversationId: props.conversationId, desktop: isDesktopRuntime(),
    openInApp: route => { props.onClose(); navigate(route); }, dismiss: props.onClose, refresh: async () => undefined,
  }), [props, drafts, owner, navigate]);
  if (isDesktopRuntime()) return null;
  return <CommandDialog open={props.open} onOpenChange={open => { if (!open) props.onClose(); }}>
    <CommandDialogPopup className="search-dialog" style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
      onPointerDown={event => { if (!(event.target instanceof Element) || !event.target.closest(".launcher-entry") || event.target.closest("button, select, input, textarea")) return; drag.current = { x: offset.x, y: offset.y, startX: event.clientX, startY: event.clientY }; event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={event => { if (!drag.current) return; const bounds = event.currentTarget.getBoundingClientRect(); const x = drag.current.x + event.clientX - drag.current.startX, y = drag.current.y + event.clientY - drag.current.startY; setOffset(current => ({ x: Math.min(current.x + window.innerWidth - bounds.right - 8, Math.max(current.x - bounds.left + 8, x)), y: Math.min(current.y + window.innerHeight - bounds.bottom - 8, Math.max(current.y - bounds.top + 8, y)) })); }}
      onPointerUp={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }} backdropClassName="search-backdrop" viewportClassName="search-viewport">
      <CommandDialogTitle>{t("launcher.title")}</CommandDialogTitle>
      <LauncherShellContext.Provider value={shell}>{props.open && <LauncherPanel />}</LauncherShellContext.Provider>
    </CommandDialogPopup>
  </CommandDialog>;
}
