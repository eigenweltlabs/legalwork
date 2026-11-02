import type { IntegrationSelection } from "./integration-mention";
import { useQuery } from "@tanstack/react-query";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { installedConnections } from "./installed-connections";
import { Fragment, useState } from "react";
import { ArrowLeft, Blocks, ChevronRight, FolderOpen, Globe, Package, Plug, Settings, Workflow } from "lucide-react";
import type { ImportedPlugin } from "@/app/lib/extension-imports";
import { mcpAuthEntryFromServer } from "@/app/mcp-connect-state";
import type { McpServerEntry, McpStatusMap, SkillCard } from "@/app/types";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { ConnectorStatus, configuredConnectorState, PluginConnectorStatus, type ConnectorState } from "@/react-app/domains/settings/pages/connector-status";
import { importedConnectorPlugin, pluginImportName, pluginImportSkillName } from "@/react-app/domains/settings/pages/plugin-import-presentation";
import { pluginFileInstalledName } from "@/react-app/domains/settings/pages/plugin-package-contents";
import { isWorkflowCard, workflowDisplayName } from "@/react-app/domains/settings/state/workflow-document";
import type { ComposerToolSection } from "@/react-app/shell/workspace-routes";

export type ComposerConnector = McpServerEntry & {
  displayName?: string;
  description?: string;
  firm?: boolean;
  state?: ConnectorState;
};

const categories: { section: ComposerToolSection; label: string }[] = [
  { section: "workflows", label: "sidebar.workflows" },
  { section: "skills", label: "dashboard.skills" },
  { section: "integrations", label: "sidebar.integrations" },
];
const itemClass = "flex min-w-0 w-full items-start gap-3 rounded-[16px] px-3 py-2.5 text-left text-gray-11 transition-colors hover:bg-gray-2/70";

export function ComposerToolMenu(props: {
  section: ComposerToolSection;
  client?: LegalworkServerClient;
  workspaceId?: string;
  onSectionChange: (section: ComposerToolSection) => void;
  skills: readonly SkillCard[];
  skillsLoading: boolean;
  connectors: readonly ComposerConnector[];
  connectorStatuses: McpStatusMap;
  connectorsLoading: boolean;
  plugins: readonly ImportedPlugin[];
  pluginsLoading: boolean;
  onSelectSkill: (name: string) => void;
  onSelectPlugin: (plugin: ImportedPlugin) => void;
  onSelectIntegration: (selection: IntegrationSelection) => void;
  onConfigure: (section: ComposerToolSection) => void;
}) {
  const accounts = useQuery({ queryKey: ["settings", "connector-accounts", props.client?.baseUrl], queryFn: () => props.client!.connectorSavedStatus(), enabled: Boolean(props.client) });
  const storage = useQuery({ queryKey: ["storage-connections", props.workspaceId], queryFn: () => props.client!.storageConnections(props.workspaceId!), enabled: Boolean(props.client && props.workspaceId) });
  const passwords = useQuery({ queryKey: ["browser-passwords", props.client?.baseUrl], queryFn: () => props.client!.listBrowserPasswords(), enabled: Boolean(props.client?.canApprove) });
  const connections = installedConnections(accounts.data, storage.data?.connections, passwords.data?.items);
  const accountLoading = accounts.isLoading || storage.isLoading || passwords.isLoading;
  const accountError = accounts.isError || storage.isError || passwords.isError;
  const [pluginId, setPluginId] = useState<string | null>(null);
  const plugins = props.plugins.filter(plugin => plugin.sourceKind === undefined || plugin.sourceKind === "plugin");
  const standaloneConnectors = props.connectors.filter(entry => !importedConnectorPlugin(entry.name, plugins));
  const activePlugin = props.section === "integrations" ? plugins.find(plugin => plugin.pluginId === pluginId) : undefined;
  const skills = props.skills.filter(skill => isWorkflowCard(skill) === (props.section === "workflows"));
  const connectorState = (entry: ComposerConnector) => entry.state ?? configuredConnectorState(entry, props.connectorStatuses[entry.name]);
  const pluginStates = (plugin: ImportedPlugin) => plugin.files.filter(file => file.objectType === "mcp").map(file => {
    const entry = props.connectors.find(connector => connector.name === pluginFileInstalledName(file));
    return entry ? connectorState(entry) : undefined;
  });

  const renderSkill = (skill: SkillCard) => {
    const workflow = isWorkflowCard(skill);
    const Icon = workflow ? Workflow : Blocks;
    return <button key={skill.name} type="button" className={itemClass} onClick={() => props.onSelectSkill(skill.name)}>
      <Icon size={16} className="mt-0.5 shrink-0 text-gray-9" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-semibold">{workflow ? workflowDisplayName(skill.name) : pluginImportSkillName(skill)}</div>
        {skill.description ? <div className="truncate text-xs text-gray-10">{skill.description}</div> : null}
      </div>
    </button>;
  };
  const renderConnector = (entry: ComposerConnector) => {
    const metadata = mcpAuthEntryFromServer(entry);
    const plugin = importedConnectorPlugin(entry.name, plugins);
    const source = entry.firm ? t("firm_hub.scope_team") : plugin ? t("integrations.plugin_source", { name: pluginImportName(plugin) }) : null;
    return <button key={entry.name} type="button" className={itemClass} onClick={() => props.onSelectIntegration({ kind: "mcp", id: entry.name, label: entry.displayName ?? metadata.name })}>
      <Plug size={16} className="mt-0.5 shrink-0 text-gray-9" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2"><span className="truncate text-xs font-semibold">{entry.displayName ?? metadata.name}</span>{source ? <span className="shrink-0 rounded-full bg-gray-3 px-2 py-0.5 text-[10px] text-gray-10">{source}</span> : null}</div>
        <div className="truncate text-xs text-gray-10">{entry.description || metadata.description || t("integrations.custom_connector")}</div>
        <div className="mt-1"><ConnectorStatus state={connectorState(entry)} /></div>
      </div>
    </button>;
  };
  const empty = (loading: boolean, message: string) => <div role="status" className="px-3 py-2 text-xs text-gray-10">{t(loading ? "composer.loading_tools" : message)}</div>;

  return <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
    <div className="grid min-h-0 flex-1 grid-cols-[152px_minmax(0,1fr)] sm:grid-cols-[176px_minmax(0,1fr)]">
      <div className="min-h-0 overflow-y-auto border-r border-dls-border bg-gray-2/30 p-2">
        {categories.map(({ section, label }) => <button key={section} type="button" aria-pressed={props.section === section}
          className={`mb-1 flex w-full items-center justify-between rounded-[16px] px-3 py-2.5 text-left text-sm transition-colors ${props.section === section ? "bg-gray-3 text-gray-12" : "text-gray-11 hover:bg-gray-2"}`}
          onClick={() => { setPluginId(null); props.onSectionChange(section); }}>
          <span className="truncate">{t(label)}</span><ChevronRight size={14} className="shrink-0 text-gray-9" />
        </button>)}
      </div>
      <div className="flex max-h-72 min-h-0 min-w-0 flex-col overflow-hidden p-2">
        <div className="mb-2 flex shrink-0 items-center justify-between gap-2 border-b border-dls-border px-1 pb-2">
          {activePlugin ? <Button variant="ghost" size="sm" className="min-w-0 shrink overflow-hidden" onClick={() => setPluginId(null)}><ArrowLeft className="size-3.5 shrink-0" /><span className="truncate">{pluginImportName(activePlugin)}</span></Button> : <span />}
          <Button variant="outline" size="sm" className="shrink-0" onClick={() => props.onConfigure(props.section)}><Settings className="size-3.5" />{t("composer.configure")}</Button>
        </div>
        <div className="min-h-0 min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain">
          {props.section === "workflows" || props.section === "skills" ? skills.length ? <div className="grid min-w-0 grid-cols-1 gap-1">{skills.map(renderSkill)}</div> : empty(props.skillsLoading, props.section === "workflows" ? "composer.no_workflows" : "context_panel.no_skills") : null}
          {props.section === "integrations" && !activePlugin ? <>
            {connections.map(connection => { const Icon = connection.kind === "website" ? Globe : connection.kind === "storage" ? FolderOpen : Plug; return <button key={connection.id} type="button" className={itemClass} onClick={() => props.onSelectIntegration(connection.selection)}>
              <Icon size={16} className="mt-0.5 shrink-0 text-gray-9" /><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><span className="truncate text-xs font-semibold">{connection.name}</span>{connection.firm ? <span className="shrink-0 rounded-full bg-gray-3 px-2 py-0.5 text-[10px] text-gray-10">{t("catalog.firm_managed")}</span> : null}</div><div className="truncate text-xs text-gray-10">{connection.description}</div>{connection.state ? <div className="mt-1"><ConnectorStatus state={connection.state} /></div> : null}</div>
            </button>; })}
            {accountLoading ? empty(true, "composer.no_integrations") : null}
            {accountError ? <p role="alert" className="px-3 py-2 text-xs text-destructive">{t("composer.integrations_load_failed")}</p> : null}{standaloneConnectors.length ? <div className="grid min-w-0 grid-cols-1 gap-1">{standaloneConnectors.map(renderConnector)}</div> : null}{!standaloneConnectors.length && !plugins.length && !connections.length && !accountLoading && !accountError ? empty(props.connectorsLoading || props.pluginsLoading, "composer.no_integrations") : null}</> : null}
          {props.section === "integrations" && !activePlugin ? plugins.length ? <div className="grid min-w-0 grid-cols-1 gap-1">{plugins.map(plugin => <div key={plugin.pluginId} className="flex min-w-0 items-start rounded-[16px] hover:bg-gray-2/70">
            <button type="button" className={`${itemClass} flex-1`} aria-label={t("composer.select_integration", { name: pluginImportName(plugin) })} onClick={() => props.onSelectPlugin(plugin)}>
              <Package size={16} className="mt-0.5 shrink-0 text-gray-9" />
              <div className="min-w-0 flex-1"><div className="truncate text-xs font-semibold">{pluginImportName(plugin)}</div>{plugin.description ? <div className="truncate text-xs text-gray-10">{plugin.description}</div> : null}<div className="mt-1"><PluginConnectorStatus states={pluginStates(plugin)} /></div></div>
            </button>
            <Button variant="ghost" size="icon-sm" className="mr-1 mt-1.5 shrink-0" aria-label={t("composer.plugin_contents", { name: pluginImportName(plugin) })} onClick={() => setPluginId(plugin.pluginId)}><ChevronRight className="size-3.5 text-gray-9" /></Button>
          </div>)}</div> : null : null}
          {activePlugin ? <div className="grid min-w-0 grid-cols-1 gap-1">
            <button type="button" className={`${itemClass} border-b border-dls-border`} onClick={() => props.onSelectPlugin(activePlugin)}><Package size={16} className="mt-0.5 shrink-0 text-gray-9" /><span className="text-xs font-medium">{t("composer.use_whole_integration")}</span></button>
            {activePlugin.files.filter(file => file.objectType === "skill" || file.objectType === "mcp").map(file => {
              const name = pluginFileInstalledName(file);
              if (file.objectType === "mcp") {
                const entry = props.connectors.find(connector => connector.name === name);
                return <Fragment key={file.configObjectId}>{entry ? renderConnector(entry) : empty(props.connectorsLoading, "plugin_details.unavailable")}</Fragment>;
              }
              const skill = props.skills.find(skill => skill.name === name);
              return <Fragment key={file.configObjectId}>{skill ? renderSkill(skill) : empty(props.skillsLoading, "plugin_details.unavailable")}</Fragment>;
            })}
            {!activePlugin.files.some(file => file.objectType === "skill" || file.objectType === "mcp") ? <p className="px-3 py-2 text-xs text-gray-10">{t("composer.integration_configure_hint")}</p> : null}
          </div> : null}
        </div>
      </div>
    </div>
  </div>;
}
