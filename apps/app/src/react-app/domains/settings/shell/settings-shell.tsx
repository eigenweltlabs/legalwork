/** @jsxImportSource react */
import type * as React from "react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, ArrowRight, ChevronDown, X } from "lucide-react";

import { WindowMenubar } from "@/react-app/shell/window-menubar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  Sidebar,
  SidebarRail,
} from "@/components/ui/sidebar";
import { t } from "../../../../i18n";
import { NotificationBell } from "../../../shell/notification-center";
import type { SettingsTab } from "../../../../app/types";
import {
  SettingsPage,
  SettingsSidebar,
  getGlobalSettingsTabs,
  getSettingsTabIcon,
  getSettingsTabLabel,
  getWorkspaceSettingsTabs,
} from "./settings-page";
import { WorkspaceIcon } from "../../../design-system/workspace-icon";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { MainActionRail, type MainRailActions } from "../../session/sidebar/main-action-rail";
import { EigenweltAccountMenu } from "../../session/sidebar/eigenwelt-account-menu";
import { useUnreadTaskCount } from "../../../kernel/notification-store";
import { useWorkspaceShellLayout } from "../../../shell/workspace-shell-layout";

type SettingsPageFrameProps = Omit<React.ComponentProps<typeof SettingsPage>, "children">;

export type SettingsShellProps = SettingsPageFrameProps & {
  accountClient: LegalworkServerClient | null;
  selectedWorkspaceId: string;
  selectedWorkspaceName: string;
  selectedWorkspaceColor: string;
  workspaces: Array<{ id: string; name: string; color: string }>;
  headerStatus?: string;
  busyHint?: string | null;
  onSelectWorkspace: (workspaceId: string) => void;
  onClose: () => void;
  headerLeadingSlot?: React.ReactNode;
  children: React.ReactNode;
  modalSlot?: React.ReactNode;
  footer?: React.ReactNode;
  compact?: boolean;
};

export function SettingsShell(props: SettingsShellProps) {
  const title = getSettingsTabLabel(props.activeTab);
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const mobile = useIsMobile();
  const unreadTasks = useUnreadTaskCount();
  const { leftSidebarWidth, leftSidebarResizing, startLeftSidebarResize } = useWorkspaceShellLayout({ expandedRightWidth: 520 });
  const sidebarStyle: React.CSSProperties & Record<"--sidebar-width" | "--sidebar-width-icon", string> = {
    "--sidebar-width": `calc(${leftSidebarWidth}px + var(--lw-window-left-rail-width))`,
    "--sidebar-width-icon": "var(--lw-window-left-rail-width)",
  };
  const actions: MainRailActions = {
    navHome: { onClick: props.onClose },
    navScheduled: { onClick: () => navigate("/scheduled") },
    navCalendar: { onClick: () => navigate("/calendar") },
    navProjects: { onClick: () => navigate("/projects") },
    navTasks: { onClick: () => navigate("/tasks") },
    navWorkflows: { onClick: () => navigate("/workflows") },
    navRecorder: { onClick: () => navigate("/recorder") },
    navEvaluations: { onClick: () => navigate("/evals") },
  };

  if (props.compact) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-background">
        <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border/70 bg-background/80 px-3 backdrop-blur-xl mac:titlebar-drag">
          <div className="flex min-w-0 flex-1 items-center gap-2 mac:titlebar-no-drag">
            <SettingsSectionMenu
              activeTab={props.activeTab}
              developerMode={props.developerMode}
              onSelectTab={props.onSelectTab}
            />
            <WorkspaceMenu
              selectedWorkspaceId={props.selectedWorkspaceId}
              selectedWorkspaceName={props.selectedWorkspaceName}
              workspaces={props.workspaces}
              onSelectWorkspace={props.onSelectWorkspace}
            />
          </div>
          <div className="flex shrink-0 items-center gap-1 mac:titlebar-no-drag">
            <NotificationBell />
            <Button
              variant="ghost"
              type="button"
              size="icon-sm"
              className="text-muted-foreground"
              onClick={props.onClose}
              title={t("dashboard.close_settings")}
              aria-label={t("dashboard.close_settings")}
            >
              <X size={17} />
            </Button>
          </div>
        </header>

        <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex min-h-0 flex-1 flex-col">
            <SettingsPage {...props}>{props.children}</SettingsPage>

            {props.modalSlot}
          </div>

          {props.footer}
        </main>
      </div>
    );
  }

  return (
    <div className="lw-window-frame flex h-dvh min-h-0 flex-col text-dls-text">
      <SidebarProvider open={sidebarOpen} onOpenChange={setSidebarOpen} style={sidebarStyle} data-sidebar-visible={sidebarOpen && !mobile} className={cn("lw-workspace-shell relative min-h-0 flex-1", leftSidebarResizing && "**:data-[slot=sidebar-container]:transition-none **:data-[slot=sidebar-gap]:transition-none [&_.lw-window-navigation]:transition-none")}>
        <header className="lw-window-topbar absolute inset-x-0 top-0 z-30 flex items-center gap-2 pr-2 electron:titlebar-drag">
          <div className="lw-window-navigation flex h-6 shrink-0 items-center gap-1 border-r border-border/60 px-3" style={{ width: sidebarOpen && !mobile ? "var(--sidebar-width)" : undefined }}>
            <Button variant="ghost" size="icon-sm" className="titlebar-no-drag text-muted-foreground" aria-label={t("sidebar.go_back")} title={t("sidebar.go_back")} onClick={() => navigate(-1)}><ArrowLeft className="size-4" /></Button>
            <Button variant="ghost" size="icon-sm" className="titlebar-no-drag text-muted-foreground" aria-label={t("sidebar.go_forward")} title={t("sidebar.go_forward")} onClick={() => navigate(1)}><ArrowRight className="size-4" /></Button>
            <SidebarTrigger className="titlebar-no-drag text-muted-foreground" />
            <WindowMenubar />
          </div>
          <div className="flex min-w-0 flex-1 items-center gap-3">
            {props.headerLeadingSlot}
            <h1 className="truncate text-[13px] font-medium tracking-[-0.01em]">{title}</h1>
            {props.developerMode && props.headerStatus && <span className="hidden truncate text-xs text-muted-foreground lg:inline">{props.headerStatus}</span>}
          </div>
          <div className="flex items-center gap-1.5 titlebar-no-drag">
            <NotificationBell />
            <Button variant="ghost" size="icon-sm" className="text-muted-foreground" onClick={props.onClose} title={t("dashboard.close_settings")} aria-label={t("dashboard.close_settings")}><X className="size-4" /></Button>
          </div>
        </header>
        <Sidebar collapsible="icon" className="mac:**:data-[sidebar=sidebar]:bg-transparent">
          <div className="flex min-h-0 flex-1">
            <MainActionRail actions={actions} unreadTasks={unreadTasks}>
              <EigenweltAccountMenu client={props.accountClient} workspaceId={props.selectedWorkspaceId} />
            </MainActionRail>
            <SettingsSidebar
              activeTab={props.activeTab}
              onSelectTab={props.onSelectTab}
              developerMode={props.developerMode}
              selectedWorkspaceId={props.selectedWorkspaceId}
              selectedWorkspaceName={props.selectedWorkspaceName}
              selectedWorkspaceColor={props.selectedWorkspaceColor}
              workspaces={props.workspaces}
              onSelectWorkspace={props.onSelectWorkspace}
            />
          </div>
          {sidebarOpen && <SidebarRail aria-label={t("session.resize_workspace_column")} title={t("session.resize_workspace_column")} onClick={event => event.preventDefault()} onPointerDown={startLeftSidebarResize} />}
        </Sidebar>
        <SidebarInset className="lw-session-workspace min-h-0 overflow-hidden pr-1.5">
          <main className="lw-workspace-surface flex min-h-0 min-w-0 flex-1 flex-col">
            <SettingsPage {...props}>{props.children}</SettingsPage>
            {props.modalSlot}
            {props.footer}
          </main>
        </SidebarInset>
      </SidebarProvider>
    </div>
  );
}

function SettingsSectionMenu(props: Pick<SettingsPageFrameProps, "activeTab" | "developerMode" | "onSelectTab">) {
  const allSections: Array<{ label: string | null; tabs: SettingsTab[] }> = [
    { label: null, tabs: ["general"] },
    { label: t("settings.group_workspace"), tabs: getWorkspaceSettingsTabs() },
    { label: t("settings.group_global"), tabs: getGlobalSettingsTabs(props.developerMode) },
  ];
  // Drop any empty groups defensively before rendering.
  const sections = allSections.filter((section) => section.tabs.length > 0);
  const ActiveIcon = getSettingsTabIcon(props.activeTab);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={(
          <Button variant="outline" size="sm" className="min-w-0 max-w-46 justify-start gap-2">
            <ActiveIcon className="size-4 shrink-0" />
            <span className="truncate">{getSettingsTabLabel(props.activeTab)}</span>
            <ChevronDown className="ml-auto size-4 shrink-0" />
          </Button>
        )}
      />
      <DropdownMenuContent className="w-64">
        {sections.map((section, index) => (
          <DropdownMenuGroup key={section.label ?? "root"}>
            {index > 0 ? <DropdownMenuSeparator /> : null}
            {section.label ? <DropdownMenuLabel>{section.label}</DropdownMenuLabel> : null}
            {section.tabs.map((tab) => {
              const Icon = getSettingsTabIcon(tab);
              return (
                <DropdownMenuItem
                  key={tab}
                  onClick={() => props.onSelectTab(tab)}
                  aria-current={props.activeTab === tab ? "page" : undefined}
                  className={props.activeTab === tab ? "bg-muted font-medium text-foreground" : undefined}
                >
                  <Icon />
                  <span>{getSettingsTabLabel(tab)}</span>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuGroup>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function WorkspaceMenu(props: Pick<SettingsShellProps, "selectedWorkspaceId" | "selectedWorkspaceName" | "workspaces" | "onSelectWorkspace">) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={(
          <Button variant="ghost" size="sm" className="min-w-0 shrink justify-start gap-2 text-dls-secondary" title={props.selectedWorkspaceName}>
            <WorkspaceIcon workspaceId={props.selectedWorkspaceId} sizeClass="size-4" />
            <span className="truncate">{props.selectedWorkspaceName}</span>
            <ChevronDown className="ml-auto size-4 shrink-0" />
          </Button>
        )}
      />
      <DropdownMenuContent className="w-56">
        {props.workspaces.map((workspace) => (
          <DropdownMenuItem
            key={workspace.id}
            onClick={() => props.onSelectWorkspace(workspace.id)}
            disabled={workspace.id === props.selectedWorkspaceId}
          >
            <WorkspaceIcon workspaceId={workspace.id} sizeClass="size-4" />
            <span className="truncate">{workspace.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
