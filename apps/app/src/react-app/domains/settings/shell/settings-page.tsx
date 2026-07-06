/** @jsxImportSource react */
import type * as React from "react";
import {
  ArrowLeft,
  Bug,
  ChevronDown,
  CloudCog,
  Cog,
  Container,
  FileStack,
  FolderLock,
  KeyRound,
  Languages,
  Layout,
  Puzzle,
  RefreshCcw,
  ShieldCheck,
  Sparkles,
  Store,
  UserCircle,
  Wrench,
  Zap,
} from "lucide-react";

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { t } from "../../../../i18n";
import { isDesktopRuntime } from "../../../../app/utils";
import type { SettingsTab } from "../../../../app/types";
import {
  SettingsContent,
  SettingsPanel,
  SettingsPanelDescription,
  SettingsPanelHeading,
  SettingsPanelTitle,
  SettingsPanelToolbar,
  SettingsPanelToolbarActions,
  SettingsPanelToolbarButton,
  SettingsPanelToolbarMessage,
  SettingsPanelToolbarStatus,
} from "./panel";
import { WorkspaceIcon } from "../../../design-system/workspace-icon";

export function getSettingsTabIcon(tab: SettingsTab) {
  switch (tab) {
    case "ai":
      return Zap;
    case "preferences":
      return ShieldCheck;
    case "shell":
      return Layout;
    case "permissions":
      return FolderLock;
    case "safety":
      return ShieldCheck;
    case "cloud-account":
      return UserCircle;
    case "cloud-marketplaces":
      return Store;
    case "cloud-workers":
      return Container;
    case "cloud-providers":
      return CloudCog;
    case "skills":
      return Sparkles;
    case "extensions":
      return Puzzle;
    case "environment":
      return KeyRound;
    case "advanced":
      return Wrench;
    case "appearance":
      return Languages;
    case "updates":
      return RefreshCcw;
    case "recovery":
      return ShieldCheck;
    case "office-addins":
      return FileStack;
    case "debug":
      return Bug;
    default:
      return Cog;
  }
}

export function getSettingsTabLabel(tab: SettingsTab) {
  switch (tab) {
    case "ai":
      return "AI Providers";
    case "preferences":
      return "Privacy";
    case "shell":
      return "Customization";
    case "permissions":
      return "Permissions";
    case "safety":
      return "Tool Permissions";
    case "cloud-account":
      return t("settings.tab_cloud_account");
    case "cloud-marketplaces":
      return t("settings.tab_cloud_marketplaces");
    case "cloud-workers":
      return t("settings.tab_cloud_workers");
    case "cloud-providers":
      return t("settings.tab_cloud_providers");
    case "skills":
      return t("settings.tab_skills");
    case "extensions":
      return t("settings.tab_extensions");
    case "environment":
      return t("settings.tab_environment");
    case "advanced":
      return t("settings.tab_advanced");
    case "appearance":
      return t("settings.tab_appearance");
    case "updates":
      return t("settings.tab_updates");
    case "recovery":
      return t("settings.tab_recovery");
    case "office-addins":
      return t("office_addins.tab_label");
    case "debug":
      return t("settings.tab_debug");
    case "general":
      return "Settings";
    default:
      return t("settings.tab_general");
  }
}

export function getSettingsTabDescription(tab: SettingsTab) {
  switch (tab) {
    case "ai":
      return "Connect services that provide AI models";
    case "preferences":
      return "Usage analytics and data sharing";
    case "shell":
      return "Branding and task suggestions";
    case "permissions":
      return "Authorized folders and file access";
    case "safety":
      return "What LegalWork may do on its own — applies to all workspaces";
    case "cloud-account":
      return t("settings.tab_description_cloud_account");
    case "cloud-marketplaces":
      return t("settings.tab_description_cloud_marketplaces");
    case "cloud-workers":
      return t("settings.tab_description_cloud_workers");
    case "cloud-providers":
      return t("settings.tab_description_cloud_providers");
    case "skills":
      return t("settings.tab_description_skills");
    case "extensions":
      return t("settings.tab_description_extensions");
    case "environment":
      return t("settings.tab_description_environment");
    case "advanced":
      return t("settings.tab_description_advanced");
    case "appearance":
      return t("settings.tab_description_appearance");
    case "updates":
      return t("settings.tab_description_updates");
    case "recovery":
      return t("settings.tab_description_recovery");
    case "office-addins":
      return t("office_addins.tab_description");
    case "debug":
      return t("settings.tab_description_debug");
    case "general":
      return "Overview of all settings";
    default:
      return t("settings.tab_description_general");
  }
}

export function getWorkspaceSettingsTabs(): SettingsTab[] {
  // Skills now live in the Integrations page (as a tab between Connectors and
  // Plugins); Workflows and Integrations (extensions) are top-level pages in the
  // main app shell. Preferences (Model) and Advanced are hidden.
  return ["permissions"];
}

export function getGlobalSettingsTabs(developerMode: boolean): SettingsTab[] {
  // Appearance/Language and Recovery are hidden (theme is fixed to Light).
  // "preferences" is the Privacy tab (usage-analytics opt-in).
  const tabs: SettingsTab[] = ["ai", "safety", "shell", "environment", "preferences", "updates"];
  // Office add-ins install into local desktop apps, so the tab is desktop-only.
  // Placed right after the first tab.
  if (isDesktopRuntime()) tabs.splice(1, 0, "office-addins");
  if (developerMode) tabs.push("debug");
  return tabs;
}

type SettingsPageProps = {
  activeTab: SettingsTab;
  onSelectTab: (tab: SettingsTab) => void;
  developerMode: boolean;
  showUpdateToolbar?: boolean;
  updateToolbarTone?: string;
  updateToolbarTitle?: string;
  updateToolbarSpinning?: boolean;
  updateToolbarLabel?: string;
  updateToolbarActionLabel?: string | null;
  updateToolbarDisabled?: boolean;
  updateRestartBlockedMessage?: string | null;
  onUpdateToolbarAction?: () => void;
  children: React.ReactNode;
};

type SettingsSidebarProps = Pick<SettingsPageProps, "activeTab" | "onSelectTab" | "developerMode"> & {
  onClose: () => void;
  selectedWorkspaceId: string;
  selectedWorkspaceName: string;
  selectedWorkspaceColor: string;
  workspaces: Array<{ id: string; name: string; color: string }>;
  onSelectWorkspace: (workspaceId: string) => void;
};

export function SettingsSidebar(props: SettingsSidebarProps) {
  const workspaceTabs = getWorkspaceSettingsTabs();
  const globalTabs = getGlobalSettingsTabs(props.developerMode);

  return (
    <Sidebar className="mac:**:data-[sidebar=sidebar]:bg-transparent">
      <div className="hidden h-10 mac:block mac:titlebar-drag" />
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton type="button" onClick={props.onClose}>
              <ArrowLeft size={14} />
              <span>{t("dashboard.back_to_app")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <SidebarMenuButton type="button">
                    <WorkspaceIcon workspaceId={props.selectedWorkspaceId} sizeClass="size-4" />
                    <span className="truncate">{props.selectedWorkspaceName}</span>
                    <ChevronDown className="ml-auto" />
                  </SidebarMenuButton>
                }
              />
              <DropdownMenuContent className="w-(--anchor-width)">
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
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {/* Top-level hub entry */}
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  type="button"
                  isActive={props.activeTab === "general"}
                  onClick={() => props.onSelectTab("general")}
                >
                  <Cog />
                  <span>{getSettingsTabLabel("general")}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>{t("settings.group_workspace")}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {workspaceTabs.map((tab) => {
                const Icon = getSettingsTabIcon(tab);
                return (
                  <SidebarMenuItem key={tab}>
                    <SidebarMenuButton
                      type="button"
                      isActive={props.activeTab === tab}
                      onClick={() => props.onSelectTab(tab)}
                    >
                      <Icon />
                      <span>{getSettingsTabLabel(tab)}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>{t("settings.group_global")}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {globalTabs.map((tab) => {
                const Icon = getSettingsTabIcon(tab);
                return (
                  <SidebarMenuItem key={tab}>
                    <SidebarMenuButton
                      type="button"
                      isActive={props.activeTab === tab}
                      onClick={() => props.onSelectTab(tab)}
                    >
                      <Icon />
                      <span>{getSettingsTabLabel(tab)}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}

export function SettingsPage(props: SettingsPageProps) {
  return (
    <SettingsContent>
      <SettingsPanel>
        <SettingsPanelHeading>
          <SettingsPanelTitle>{getSettingsTabLabel(props.activeTab)}</SettingsPanelTitle>
          <SettingsPanelDescription>{getSettingsTabDescription(props.activeTab)}</SettingsPanelDescription>
        </SettingsPanelHeading>

        {props.showUpdateToolbar && props.activeTab === "general" ? (
          <SettingsPanelToolbar>
            <SettingsPanelToolbarActions>
              <SettingsPanelToolbarStatus
                tone={props.updateToolbarTone}
                title={props.updateToolbarTitle}
                spinning={props.updateToolbarSpinning}
              >
                {props.updateToolbarLabel}
              </SettingsPanelToolbarStatus>
              {props.updateToolbarActionLabel ? (
                <SettingsPanelToolbarButton
                  onClick={props.onUpdateToolbarAction}
                  disabled={props.updateToolbarDisabled}
                  title={props.updateRestartBlockedMessage ?? ""}
                >
                  {props.updateToolbarActionLabel}
                </SettingsPanelToolbarButton>
              ) : null}
            </SettingsPanelToolbarActions>
            {props.updateRestartBlockedMessage ? (
              <SettingsPanelToolbarMessage>{props.updateRestartBlockedMessage}</SettingsPanelToolbarMessage>
            ) : null}
          </SettingsPanelToolbar>
        ) : null}
      </SettingsPanel>

      {props.children}
    </SettingsContent>
  );
}
