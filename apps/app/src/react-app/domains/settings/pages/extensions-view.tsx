import type { PluginImportProvider } from "@legalwork/types/plugin-import";
import { PluginImportDialog, type PluginImportStore } from "./plugin-import-dialog";
/** @jsxImportSource react */
import { useEffect, useState, type ReactNode } from "react";
import { Blocks, Cpu, HardDrive, Plug, type LucideIcon } from "lucide-react";

import { t } from "../../../../i18n";
import { Button } from "@/components/ui/button";
import { SectionHeading } from "@/react-app/design-system/surface";

import { PluginsView, type PluginsExtensionsStore } from "./plugins-view";
import { HubTabs } from "../segmented-tabs";
import { HubScopeContext, HubScopeToggle, type HubScope } from "./hub-scope-context";

export type ExtensionsSection = "all" | "mcp" | "skills" | "plugins" | "storage";

type ExtensionsTab = "connectors" | "skills" | "plugins" | "storage";

type SuggestedPlugin = {
  name: string;
  packageName: string;
  description: string;
  tags: string[];
  aliases?: string[];
  installMode?: "simple" | "guided";
  steps?: Array<{
    title: string;
    description: string;
    command?: string;
    url?: string;
    path?: string;
    note?: string;
  }>;
};

export type ExtensionsViewProps = {
  busy: boolean;
  /** Engine plugins are code for developers: their tab shows only in developer mode. */
  developerMode: boolean;
  selectedWorkspaceRoot: string;
  isRemoteWorkspace: boolean;
  canEditPlugins: boolean;
  canUseGlobalScope: boolean;
  accessHint?: string | null;
  suggestedPlugins: SuggestedPlugin[];
  extensions: PluginsExtensionsStore;
  pluginImports?: PluginImportStore;
  mcpConnectedAppsCount: number;
  /** Connectors tab — the MCP quick-connect grid + configured servers + built-ins. */
  mcpView: ReactNode;
  /** Connectors tab, Local: the firm's connectors on this computer, with sign-in and own keys. */
  firmConnectorsView?: ReactNode;
  storageView?: ReactNode;
  /** Skills tab — built-in, installed and imported skills, with add/import. */
  skillsView: ReactNode;
  /** Whether the firm is connected + entitled (shows the Local/Team toggle). */
  hasTeamHub?: boolean;
  /** Opens the multi-select "Share with your firm" dialog. */
  onOpenTeamShare?: () => void;
  onRefresh: () => void;
  initialSection?: ExtensionsSection;
  setSectionRoute?: (tab: "mcp" | "skills" | "plugins" | "storage") => void;
  showHeader?: boolean;
};

// The Integrations page covers connectors (MCP), file storage and skills; in
// developer mode also the engine's plugins (code it loads).
// Built per render, not once at import: `t()` reads the current language, so a
// module-level constant would freeze the tabs in whatever language loaded first.
const tabs = (developerMode: boolean): Array<{ id: ExtensionsTab; label: string; icon: LucideIcon; subtitle: string }> => [
  { id: "connectors", label: t("extensions.connectors_label"), icon: Plug, subtitle: t("extensions.apps_subtitle_short") },
  { id: "storage", label: t("storage.tab"), icon: HardDrive, subtitle: t("storage.intro") },
  { id: "skills", label: "Skills", icon: Blocks, subtitle: t("extensions.skills_subtitle") },
  ...(developerMode ? [{ id: "plugins" as const, label: t("extensions.engine_plugins"), icon: Cpu, subtitle: t("extensions.engine_plugins_subtitle") }] : []),
];

// Neutral segmented control matching the reference: a soft gray track with a
// white active pill (no accent fill). Shared by the tab switcher.

export function ExtensionsView(props: ExtensionsViewProps) {
  // An old link to the Plugins tab opens Skills, where the built-in ones are now.
  const initialTab: ExtensionsTab =
    props.initialSection === "storage" ? "storage" : props.initialSection === "plugins"
      ? props.developerMode ? "plugins" : "skills"
      : props.initialSection === "skills"
        ? "skills"
        : "connectors";
  const [importProvider, setImportProvider] = useState<PluginImportProvider | null>(null);
  const [importVersion, setImportVersion] = useState(0);
  const [tab, setTab] = useState<ExtensionsTab>(initialTab);
  useEffect(() => setTab(initialTab), [initialTab]);
  // Local | Team is the OUTER toggle for the whole Integrations page; the
  // Connectors/Skills tabs sit inside it. The sub-views follow this scope via
  // HubScopeContext. The firm hands out no engine plugins: that tab is local.
  const [selectedScope, setHubScope] = useState<HubScope>("local");
  const teamHub = props.hasTeamHub === true && tab !== "plugins";
  const hubScope = teamHub || tab === "storage" ? selectedScope : "local";

  const selectTab = (next: ExtensionsTab) => {
    setTab(next);
    props.setSectionRoute?.(next === "connectors" ? "mcp" : next);
  };

  const TABS = tabs(props.developerMode);
  const activeTab = TABS.find((entry) => entry.id === tab) ?? TABS[0];

  return (
    <section className="w-full min-w-0 max-w-5xl space-y-6">
      {props.showHeader !== false ? <SectionHeading size="page" title={t("extensions.eyebrow_integrations")} description={tab !== "storage" ? activeTab.subtitle : undefined} action={teamHub || tab === "storage" ? <>
        <HubScopeToggle scope={hubScope} onChange={setHubScope} />
        {hubScope === "team" && tab !== "storage" && props.onOpenTeamShare ? <Button variant="outline" onClick={props.onOpenTeamShare}>{t("extensions.share_with_firm")}</Button> : null}
      </> : undefined} /> : null}
      {/* Local | Team is the page-level toggle; Connectors/Skills sit inside it. */}
      {(teamHub || tab === "storage") && props.showHeader === false ? (
        <div className="flex items-center justify-between gap-3">
          <HubScopeToggle scope={hubScope} onChange={setHubScope} />
          {hubScope === "team" && tab !== "storage" && props.onOpenTeamShare ? (
            <Button variant="outline" onClick={props.onOpenTeamShare}>
              {t("extensions.share_with_firm")}
            </Button>
          ) : null}
        </div>
      ) : null}

      {hubScope === "local" && props.pluginImports ? <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={props.busy || !props.canEditPlugins} onClick={() => setImportProvider("chatgpt")}>{t("extensions.import_chatgpt")}</Button>
        <Button variant="outline" disabled={props.busy || !props.canEditPlugins} onClick={() => setImportProvider("claude")}>{t("extensions.import_claude")}</Button>
      </div> : null}
      {importProvider && props.pluginImports ? <PluginImportDialog provider={importProvider} store={props.pluginImports} canUseGlobalScope={props.canUseGlobalScope} onClose={() => setImportProvider(null)} onImported={() => { setImportVersion(value => value + 1); props.onRefresh(); }} /> : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <HubTabs items={TABS} value={tab} onChange={selectTab} />
        <div className="flex items-center gap-2">
          {props.mcpConnectedAppsCount > 0 ? (
            <div className="hidden items-center gap-2 rounded-full bg-green-3 px-3 py-1 sm:inline-flex">
              <div className="size-2 rounded-full bg-green-9" />
              <span className="text-xs font-medium text-green-11">
                {t("extensions.app_count", { count: props.mcpConnectedAppsCount })}
              </span>
            </div>
          ) : null}
          <Button variant="outline" onClick={props.onRefresh}>
            {t("common.refresh")}
          </Button>
        </div>
      </div>

      <HubScopeContext.Provider key={importVersion} value={hubScope}>
      {tab === "connectors" ? (
        <div className="space-y-8">
          {hubScope === "local" ? props.firmConnectorsView : null}
          {props.mcpView}
        </div>
      ) : null}

      {tab === "storage" ? props.storageView : null}

      {tab === "skills" ? props.skillsView : null}

      {tab === "plugins" ? (
        <PluginsView
          extensions={props.extensions}
          busy={props.busy}
          selectedWorkspaceRoot={props.selectedWorkspaceRoot}
          canEditPlugins={props.canEditPlugins}
          canUseGlobalScope={props.canUseGlobalScope}
          accessHint={props.accessHint}
          suggestedPlugins={props.suggestedPlugins}
        />
      ) : null}
      </HubScopeContext.Provider>
    </section>
  );
}
