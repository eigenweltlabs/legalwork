import { useMemo } from "react";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { t } from "@/i18n";
import { useControlAction, type LegalworkControlAction } from "../../shell/control/control-provider";
import { projectViewTab, usePanelTabStore, workspacePanelKey } from "../session/panel/panel-tab-store";
import { BackOfficeTabNavigationProvider, backOfficePathFor, openBackOfficeArgs } from "./back-office-navigation";
import { BackOfficePage } from "./back-office-page";

export function BackOfficeWorkspaceTab({ client, scope, path, active }: {
  client: LegalworkServerClient;
  scope: string;
  path?: string;
  active: boolean;
}) {
  return <BackOfficeTabNavigationProvider path={path} onNavigate={target => usePanelTabStore.getState().setBackOfficePath(scope, target)}>
    <div className="bo-workspace-tab"><BackOfficePage client={client} active={active} /></div>
  </BackOfficeTabNavigationProvider>;
}

export function useOpenBackOfficeWorkspaceAction(workspaceId: string | null, sessionIds: readonly string[], onShow: () => void) {
  const action = useMemo<LegalworkControlAction | null>(() => workspaceId ? {
    id: "workspace.back_office.open",
    label: t("back_office.open_in_workspace"),
    description: "Open the full Back Office in a tab in the current workspace. For a saved view or record, pass its object ID and exact view or record ID.",
    sideEffect: "navigation",
    args: [
      { name: "objectId", type: "string", description: "Back Office object ID from legalwork_back_office_discover." },
      { name: "viewId", type: "string", description: "Saved view UUID for that object." },
      { name: "recordId", type: "string", description: "Record UUID for that object." },
    ],
    execute: (args, { callerSessionId }) => {
      if (callerSessionId && !sessionIds.includes(callerSessionId)) throw new Error(t("back_office.workspace_session_required"));
      const input = openBackOfficeArgs.safeParse(args ?? {});
      if (!input.success) throw new Error(t("back_office.invalid_tab_target"));
      const tab = projectViewTab("back-office", t("sidebar.backOffice"), backOfficePathFor(input.data));
      usePanelTabStore.getState().openTab(workspacePanelKey(workspaceId), tab, undefined, undefined, { besideChat: true });
      onShow();
      return { opened: true, workspaceId, tabId: tab.id };
    },
  } : null, [workspaceId, sessionIds, onShow]);
  useControlAction(action);
}
