import { useEffect, useState, type ReactNode } from "react";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { t } from "@/i18n";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { useUiStateStore } from "@/react-app/shell/ui-state-store";
import { ControlActionScope } from "@/react-app/shell/control/control-provider";
import { DocumentPane } from "../../session/panel/document-pane";
import { PANEL_OPEN_TAB_EVENT, type PanelTabRequest } from "../../session/panel/panel-tab-request";
import { workflowsPanelKey } from "../../session/panel/panel-scope";
import { usePanelTabStore, useSessionPanelState } from "../../session/panel/panel-tab-store";
import { SidePanel } from "../../session/panel/side-panel";

// Keep this identity stable: control registration updates the surrounding app.
const noControlSessions: readonly string[] = [];

export function WorkflowsWorkspace({ workspaceId, client, children, active = true }: {
  active?: boolean;
  workspaceId: string;
  client?: LegalworkServerClient | null;
  children: ReactNode;
}) {
  const scope = workflowsPanelKey(workspaceId);
  const panel = useSessionPanelState(scope);
  const panelOpen = useUiStateStore(state => state.sidePanelState[scope] === "panel");
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const mobile = useIsMobile();
  const visible = active && panelOpen && panel.tabs.length > 0;
  useEffect(() => {
    const open = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const tab: PanelTabRequest = event.detail;
      if (tab?.destination?.kind !== "workflows" || tab.destination.workspaceId !== workspaceId) return;
      usePanelTabStore.getState().openTab(scope, tab, undefined, undefined, { preview: tab.openAsPreview });
      useUiStateStore.getState().setSidePanelState(scope, "panel");
    };
    window.addEventListener(PANEL_OPEN_TAB_EVENT, open);
    return () => window.removeEventListener(PANEL_OPEN_TAB_EVENT, open);
  }, [scope, workspaceId]);
  return <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden" data-workflows-workspace>
    <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
      <ResizablePanel id="workflow-library" minSize={mobile ? "0px" : "280px"} className={cn("flex min-h-0 flex-col", mobile && visible && "hidden")}>
        {children}
      </ResizablePanel>
      {visible && <>
        {!mobile && <ResizableHandle withHandle />}
        <ResizablePanel id="workflow-editors" defaultSize={mobile ? "100%" : "60%"} minSize={mobile ? "0px" : "320px"} className="flex min-h-0 flex-col overflow-hidden">
          {mobile && <div className="shrink-0 border-b border-border px-3 py-2"><Button variant="ghost" size="sm" onClick={() => useUiStateStore.getState().setSidePanelState(scope, null)}>{t("workflows.back_to_library")}</Button></div>}
          <div ref={setHost} className="min-h-0 flex-1" />
        </ResizablePanel>
      </>}
    </ResizablePanelGroup>
    {panel.tabs.length > 0 && <DocumentPane destination={visible ? host : null}>
      <ControlActionScope active={visible}>
        <SidePanel sessionId={scope} client={client ?? null} workspaceId={workspaceId} workspaceRoot="" controlSessionIds={noControlSessions}
          tabDestination={{ kind: "workflows", workspaceId }} visible={visible}
          onClose={() => useUiStateStore.getState().setSidePanelState(scope, null)} />
      </ControlActionScope>
    </DocumentPane>}
  </div>;
}
