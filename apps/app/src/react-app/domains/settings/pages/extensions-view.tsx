import { PluginImportDialog, type PluginImportStore } from "./plugin-import-dialog";
import { PluginCreateDialog, type PluginCreateStore } from "./plugin-create-dialog";
/** @jsxImportSource react */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Blocks, Download, FolderOpen, HardDrive, Loader2, Package } from "lucide-react";

import { t } from "../../../../i18n";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { SectionHeading } from "@/react-app/design-system/surface";

import { PluginsView, type PluginsExtensionsStore } from "./plugins-view";
import { HubScopeContext } from "./hub-scope-context";
import { HubTabs, type HubTab } from "../segmented-tabs";
import { IntegrationAddMenu, IntegrationSearch, IntegrationSourceFilter, IntegrationLibraryLayoutContext, IntegrationLibraryPage, IntegrationMoreMenu, type IntegrationAddRequest, type IntegrationLibraryKind, type IntegrationLibrarySource } from "./integration-library";
import { ImportSkillsButton, type SkillImportSource, type SkillImportStore, type SkillsExtensionsStore } from "./skills-view";
import { orgPolicyAllows, useOrgPolicyForbids } from "../../connections/org-policy";
import { ImportedPackages } from "./skill-packages";
import type { ImportedPlugin } from "@/app/lib/extension-imports";
import type { SkillCard } from "@/app/types";
import type { SkillDetailsStore } from "./skill-details-dialog";
import type { PluginDetailsAccess } from "./plugin-details-dialog";
import type { ConnectorState } from "./connector-status";
import { pluginImportDestination } from "./plugin-import-presentation";

export type ExtensionsSection = "all" | "mcp" | "skills" | "plugins" | "storage";

type ExtensionsTab = "skills" | "plugins" | "storage";

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
  /** Engine plugin management is available through More only in developer mode. */
  developerMode: boolean;
  selectedWorkspaceRoot: string;
  workspaceKey?: string;
  /** Re-read the library when the server starts or reconnects. */
  libraryConnection?: object | null;
  isRemoteWorkspace: boolean;
  canEditPlugins: boolean;
  canUseGlobalScope: boolean;
  accessHint?: string | null;
  suggestedPlugins: SuggestedPlugin[];
  extensions: PluginsExtensionsStore;
  pluginImports?: PluginImportStore;
  pluginCreation?: PluginCreateStore;
  skillImports?: SkillImportStore & Pick<SkillsExtensionsStore, "skills">;
  skillTools?: Pick<SkillsExtensionsStore, "importedPackages" | "removeImportedPackage" | "revealSkillsFolder">;
  skillDetails?: SkillDetailsStore & { skills: () => SkillCard[]; readPackageComponent: PluginDetailsAccess["readComponent"] };
  renderPluginConnector?: PluginDetailsAccess["renderConnector"];
  connectorState?: (name: string) => ConnectorState | undefined;
  canImportSkills?: boolean;
  canAddConnector?: boolean;
  canAddSkill?: boolean;
  canAddStorage?: boolean;
  mcpConnectedAppsCount: number;
  /** Connectors tab — the MCP quick-connect grid + configured servers + built-ins. */
  mcpView: ReactNode;
  storageView?: ReactNode;
  /** Skills tab — built-in, installed and imported skills, with add/import. */
  skillsView: ReactNode;
  onRefresh: () => void;
  initialSection?: ExtensionsSection;
  setSectionRoute?: (tab: "mcp" | "skills" | "plugins" | "storage") => void;
  showHeader?: boolean;
};

// Installed workflow bundles have their own library. Engine extensions stay
// behind a developer-only action rather than sharing the Plugins category.
// Built per render, not once at import: `t()` reads the current language, so a
// module-level constant would freeze the tabs in whatever language loaded first.
const tabs = (): HubTab<ExtensionsTab>[] => {
  const items: HubTab<ExtensionsTab>[] = [
    { id: "plugins", label: t("extensions.filter_plugins"), icon: Package },
    { id: "skills", label: "Skills", icon: Blocks },
    { id: "storage", label: t("storage.tab"), icon: HardDrive },
  ];
  return items;
};

export function ExtensionsView(props: ExtensionsViewProps) {
  const initialTab: ExtensionsTab =
    props.initialSection === "storage" ? "storage" : props.initialSection === "plugins"
      ? "plugins"
      : props.initialSection === "skills"
        ? "skills"
        : "plugins";
  const [importOpen, setImportOpen] = useState(false);
  const [createPluginOpen, setCreatePluginOpen] = useState(false);
  const addButton = useRef<HTMLButtonElement>(null);
  const [skillImportOpen, setSkillImportOpen] = useState(false);
  const [skillImportSource, setSkillImportSource] = useState<SkillImportSource>("files");
  const importButton = useRef<HTMLButtonElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const [enginePluginsOpen, setEnginePluginsOpen] = useState(false);
  const [importVersion, setImportVersion] = useState(0);
  const [packageLibrary, setPackageLibrary] = useState<{ target: string; items: ImportedPlugin[] } | null>(null);
  const packageTarget = props.workspaceKey ?? props.selectedWorkspaceRoot;
  const currentPackageTarget = useRef(packageTarget);
  currentPackageTarget.current = packageTarget;
  useEffect(() => setCreatePluginOpen(false), [packageTarget]);
  useEffect(() => {
    let stopped = false;
    if (props.libraryConnection === null) { setPackageLibrary(null); return; }
    if (props.skillTools) void props.skillTools.importedPackages()
      .then(items => { if (!stopped) setPackageLibrary({ target: packageTarget, items }); })
      .catch(error => { if (!stopped) toast.error(error instanceof Error ? error.message : t("skills.unknown_error")); });
    return () => { stopped = true; };
  }, [props.skillTools, packageTarget, props.isRemoteWorkspace, props.libraryConnection, importVersion]);
  const [tab, setTab] = useState<ExtensionsTab>(initialTab);
  const [pluginSearch, setPluginSearch] = useState("");
  const [source, setSource] = useState<IntegrationLibrarySource>("all");
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (listRef.current) listRef.current.scrollTop = 0; }, [tab, source, packageTarget]);
  const [addRequest, setAddRequest] = useState<IntegrationAddRequest | null>(null);
  const [connectorToOpen, setConnectorToOpen] = useState<string | null>(null);
  const onConnectorOpened = useCallback(() => setConnectorToOpen(null), []);
  useEffect(() => { setConnectorToOpen(null); setPluginSearch(""); }, [packageTarget]);
  const addSequence = useRef(0);
  const onAddHandled = useCallback(() => setAddRequest(null), []);
  const connectorsForbidden = useOrgPolicyForbids("connectors.allowCustom");
  const skillsForbidden = useOrgPolicyForbids("skills.allowCustom");
  const storageForbidden = useOrgPolicyForbids("storage.allowPersonal");
  const pluginsForbidden = useOrgPolicyForbids("plugins.allowCustom");
  const [actionsTarget, setActionsTarget] = useState<HTMLElement | null>(null);
  const [searchTarget, setSearchTarget] = useState<HTMLElement | null>(null);
  const [directoryRequest, setDirectoryRequest] = useState(0);
  useEffect(() => setTab(initialTab), [initialTab]);
  const selectTab = (next: ExtensionsTab) => {
    setTab(next);
    props.setSectionRoute?.(next);
  };

  const TABS = tabs();
  const canImportPlugins = props.canEditPlugins && props.canUseGlobalScope;
  const canImportSkills = Boolean(props.skillImports && props.canImportSkills);
  const refresh = () => { setImportVersion(value => value + 1); props.onRefresh(); };
  const packageRemoved = (_pluginId: string) => {
    setPackageLibrary(null);
    refresh();
  };
  const importedSkills = () => { setSource("all"); selectTab("skills"); refresh(); };
  const importedPackage = () => { setPluginSearch(""); setSource("all"); selectTab("plugins"); refresh(); };
  const requestAdd = (kind: IntegrationLibraryKind) => {
    setPluginSearch("");
    setSource("all");
    selectTab(kind === "connector" ? "plugins" : kind === "skill" ? "skills" : "storage");
    setAddRequest({ kind, id: ++addSequence.current });
  };
  const detailsAccess: PluginDetailsAccess | undefined = props.skillDetails && props.renderPluginConnector ? { skills: props.skillDetails.skills, skillStore: props.skillDetails, canEditSkills: props.canAddSkill !== false, renderConnector: props.renderPluginConnector, readComponent: props.skillDetails.readPackageComponent } : undefined;
  const directoryActions = <Button
    variant="outline"
    className="h-9"
    size="sm"
    disabled={props.busy || !props.pluginCreation || !canImportPlugins || pluginsForbidden || (skillsForbidden && connectorsForbidden)}
    onClick={async () => { if (await orgPolicyAllows("plugins.allowCustom")) setCreatePluginOpen(true); }}
  >{t("integrations.custom")}</Button>;
  const libraryLayout = { directoryActions, customPluginOpen: createPluginOpen, pluginSearch, actions: actionsTarget, search: searchTarget, directoryRequest, onRefresh: refresh, revision: importVersion, source, addRequest, onAddHandled, connectorToOpen, onConnectorOpened, ownsMoreMenu: true, importedPackages: packageLibrary?.target === packageTarget ? packageLibrary.items : undefined, connectorState: props.connectorState };

  return (
    <IntegrationLibraryLayoutContext.Provider value={libraryLayout}>
      <IntegrationLibraryPage>
      <section className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-5 overflow-hidden">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-4">
          <SectionHeading size="page" className={props.showHeader === false ? "sr-only" : undefined} title={t("extensions.eyebrow_integrations")} description={props.showHeader === false ? undefined : t("integrations.description")} />
          <div className="flex max-w-full flex-wrap items-center gap-2">
            {props.pluginImports ? <Button ref={importButton} variant="outline" disabled={props.busy || (!canImportPlugins && !canImportSkills)} onClick={() => setImportOpen(true)}><Download className="size-3.5" />{t("integrations.import_action")}</Button> : null}
            <IntegrationAddMenu size="default" triggerRef={addButton} disabled={props.busy} actions={[
              { label: t("extensions.filter_plugins"), icon: Package, onClick: () => setDirectoryRequest(value => value + 1) },
              { label: t("skills.title"), icon: Blocks, disabled: props.canAddSkill === false || skillsForbidden, onClick: () => requestAdd("skill") },
              { label: t("storage.tab"), icon: HardDrive, disabled: props.canAddStorage === false || !props.storageView || storageForbidden, onClick: () => requestAdd("storage") },
            ]} />
            <div ref={setActionsTarget} className="flex items-center gap-2 empty:hidden" />
            <IntegrationMoreMenu pageToolbar triggerRef={moreButton} busy={props.busy}>
              <DropdownMenuItem disabled={props.busy || props.isRemoteWorkspace || !props.skillTools} onClick={async () => {
                if (props.busy || props.isRemoteWorkspace || !props.skillTools) return;
                try { await props.skillTools.revealSkillsFolder(); }
                catch (error) { toast.error(error instanceof Error ? error.message : t("skills.unknown_error")); }
              }}><FolderOpen />{t("skills.reveal_folder")}</DropdownMenuItem>
              {props.developerMode ? <DropdownMenuItem disabled={props.busy} onClick={() => setEnginePluginsOpen(true)}><Package />{t("extensions.engine_plugins")}</DropdownMenuItem> : null}
            </IntegrationMoreMenu>
          </div>
        </div>
        {createPluginOpen && props.pluginCreation ? <PluginCreateDialog key={packageTarget} store={props.pluginCreation} allowSkills={props.canAddSkill !== false && !skillsForbidden} allowConnectors={props.canAddConnector !== false && !connectorsForbidden} returnFocus={addButton} onClose={() => setCreatePluginOpen(false)} onCreated={plugin => {
          if (currentPackageTarget.current !== packageTarget) return;
          setPackageLibrary(current => ({ target: packageTarget, items: [...(current?.target === packageTarget ? current.items : []).filter(item => item.pluginId !== plugin.pluginId), plugin] }));
          importedPackage();
          toast.success(t("plugin_create.created", { name: plugin.displayName ?? plugin.name }));
        }} /> : null}
        {enginePluginsOpen && props.developerMode ? <Dialog open onOpenChange={setEnginePluginsOpen}>
          <DialogContent finalFocus={moreButton} className="max-h-[calc(100dvh-3rem)] overflow-y-auto bg-background sm:max-w-3xl">
            <DialogHeader><DialogTitle>{t("extensions.engine_plugins")}</DialogTitle><DialogDescription>{t("plugins.desc")}</DialogDescription></DialogHeader>
            <PluginsView extensions={props.extensions} busy={props.busy} selectedWorkspaceRoot={props.selectedWorkspaceRoot} canEditPlugins={props.canEditPlugins} canUseGlobalScope={props.canUseGlobalScope} accessHint={props.accessHint} suggestedPlugins={props.suggestedPlugins} />
          </DialogContent>
        </Dialog> : null}
        {importOpen && props.pluginImports ? <PluginImportDialog store={props.pluginImports} onClose={() => setImportOpen(false)} onImported={async preview => {
          if (props.skillTools) {
            const items = await props.skillTools.importedPackages();
            if (!items.some(item => item.pluginId === preview.id)) throw new Error(t("extensions.import_library_failed"));
            if (currentPackageTarget.current !== packageTarget) throw new Error(t("extensions.import_library_failed"));
            setPackageLibrary({ target: packageTarget, items });
          }
          const destination = pluginImportDestination(preview);
          setImportVersion(value => value + 1);
          setSource("all");
          setPluginSearch("");
          selectTab(destination.tab === "connectors" ? "plugins" : destination.tab);
          setConnectorToOpen(destination.connectorName);
        }}
          returnFocus={importButton}
          canImportPlugins={canImportPlugins && !props.busy}
          canImportSkills={canImportSkills && !props.busy}
          canImportLocalSkills={canImportSkills && !props.busy && !props.isRemoteWorkspace}
          onImportSkills={props.skillImports ? async importSource => {
            if (!props.canImportSkills || props.busy || (importSource === "files" && props.isRemoteWorkspace) || !(await orgPolicyAllows("skills.allowCustom"))) return;
            setImportOpen(false);
            setSource("all");
            selectTab("skills");
            setSkillImportSource(importSource);
            setSkillImportOpen(true);
          } : undefined} /> : null}
        {props.skillImports ? <ImportSkillsButton open={skillImportOpen} onOpenChange={setSkillImportOpen} source={skillImportSource} returnFocus={importOpen ? false : importButton} asWorkflow={false} busy={props.busy} canUseDesktopTools={!props.isRemoteWorkspace} existingNames={new Set(props.skillImports.skills().map(skill => skill.name))} extensions={props.skillImports} onImported={importedSkills} onPackageImported={importedPackage} onBack={() => { setSkillImportOpen(false); setImportOpen(true); }} /> : null}
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border/70 pb-4">
          <HubTabs items={TABS} value={tab} onChange={selectTab} label={t("extensions.eyebrow_integrations")} />
          <div className="flex w-full items-center gap-2 sm:w-auto">
            {tab === "plugins" ? <IntegrationSearch value={pluginSearch} onChange={setPluginSearch} label={t("integrations.search_plugins")} /> : null}
            <div ref={setSearchTarget} className={tab === "plugins" ? "hidden" : "h-9 min-w-0 flex-1 sm:w-64 sm:flex-none"} />
            <IntegrationSourceFilter value={source} onChange={setSource} />
          </div>
        </div>

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <HubScopeContext.Provider value="local">
          <div hidden={tab !== "plugins"} className="space-y-1">
            <IntegrationLibraryLayoutContext.Provider value={{ ...libraryLayout, actions: null, search: null }}>
              {props.mcpView}
            </IntegrationLibraryLayoutContext.Provider>

            {tab === "plugins" && props.skillTools ? props.libraryConnection === null ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("common.loading")}</p> : <ImportedPackages key={packageTarget} extensions={props.skillTools} busy={props.busy} revision={importVersion} onChanged={packageRemoved} canRemove={props.canEditPlugins} detailsAccess={detailsAccess} imports={props.pluginImports} library searchQuery={pluginSearch} /> : null}
          </div>

          {tab === "storage" ? props.storageView : null}

          {tab === "skills" ? props.skillsView : null}

        </HubScopeContext.Provider>
        </div>
      </section>
      </IntegrationLibraryPage>
    </IntegrationLibraryLayoutContext.Provider>
  );
}
