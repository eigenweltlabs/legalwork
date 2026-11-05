import { IntegrationLibraryRow, IntegrationGroupHeading, IntegrationEmptyState, IntegrationSearch, useIntegrationLibraryLayout } from "./integration-library";
/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { Blocks, Loader2, Package } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

import { t } from "@/i18n";
import { toast } from "@/components/ui/sonner";
import { ConfirmModal } from "@/react-app/design-system/modals/confirm-modal";
import type { ImportedPlugin } from "../../../../app/lib/extension-imports";
import { BUILT_IN_SKILLS } from "../built-in-skills";
import { pluginImportName } from "./plugin-import-presentation";
import { PluginDetailsDialog, type PluginDetailsAccess } from "./plugin-details-dialog";
import { packageParts, pluginFileInstalledName } from "./plugin-package-contents";
import { PluginConnectorStatus } from "./connector-status";
import type { PluginImportStore } from "./plugin-import-dialog";
export { ImportedPackageContents, packageParts } from "./plugin-package-contents";

/**
 * Installed bundles in the Plugins tab and all import records in its manager (a
 * package brings skills, connectors and commands at once; each part also shows
 * in its own list) and the skills built into LegalWork.
 */

export type SkillPackagesStore = {
  importedPackages: () => Promise<ImportedPlugin[]>;
  removeImportedPackage: (pluginId: string) => Promise<void>;
};

export function ImportedPackages(props: {
  extensions: SkillPackagesStore;
  busy: boolean;
  /** Changes when a package was imported, so the list is read again. */
  revision: number;
  searchQuery?: string;
  showEmpty?: boolean;
  onChanged?: (pluginId: string) => void;
  /** The public Plugins library excludes standalone skill/connector imports. */
  library?: boolean;
  canRemove?: boolean;
  detailsAccess?: PluginDetailsAccess;
  imports?: PluginImportStore;
}) {
  const { extensions } = props;
  const layout = useIntegrationLibraryLayout();
  const cached = layout?.importedPackages;
  const connectorState = layout?.connectorState;
  const [packages, setPackages] = useState<readonly ImportedPlugin[]>(cached ?? []);
  const [loading, setLoading] = useState(cached === undefined);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [selected, setSelected] = useState<ImportedPlugin | null>(null);
  const [removing, setRemoving] = useState<ImportedPlugin | null>(null);

  useEffect(() => {
    let stopped = false;
    if (cached !== undefined) { setPackages(cached); setLoading(false); setError(""); return; }
    setLoading(true);
    setError("");
    extensions.importedPackages()
      .then((list) => {
        if (!stopped) setPackages(list);
      })
      .catch(cause => { if (!stopped) setError(cause instanceof Error ? cause.message : t("skills.unknown_error")); })
      .finally(() => { if (!stopped) setLoading(false); });
    return () => {
      stopped = true;
    };
  }, [extensions, props.revision, cached, retry]);

  async function remove(plugin: ImportedPlugin) {
    try {
      await extensions.removeImportedPackage(plugin.pluginId);
      setPackages((list) => list.filter((each) => each.pluginId !== plugin.pluginId));
      props.onChanged?.(plugin.pluginId);
      toast.success(t("skills.package_removed", { name: pluginImportName(plugin) }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("skills.unknown_error"));
    }
  }

  const query = (props.searchQuery ?? searchQuery).trim().toLowerCase();
  const team = props.library && layout?.source === "team";
  const visiblePackages = packages.filter(plugin => (!props.library || plugin.sourceKind === undefined || plugin.sourceKind === "plugin") && (!query || [pluginImportName(plugin), plugin.description ?? "", packageParts(plugin.files.map(file => file.objectType))].join(" ").toLowerCase().includes(query)));
  if (!loading && !error && (visiblePackages.length === 0 || team) && !props.showEmpty) return null;
  return (
    <div className="space-y-4">
      {props.library && props.searchQuery === undefined ? <IntegrationSearch toolbar value={searchQuery} onChange={setSearchQuery} label={t("integrations.search_plugins")} /> : null}
      {team ? <IntegrationEmptyState icon={Package} title={t("integrations.team_plugins_unavailable")} /> : loading ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("common.loading")}</p> : error ? <div role="alert" className="flex items-center gap-3"><p className="text-sm text-destructive">{error}</p><Button variant="outline" size="sm" onClick={() => setRetry(value => value + 1)}>{t("common.refresh")}</Button></div> : <>
      <IntegrationGroupHeading hideInLibrary title={t("skills.packages_title")} count={visiblePackages.length} />
      {visiblePackages.length === 0 ? <IntegrationEmptyState icon={Package} title={t(props.library ? query ? "integrations.no_plugin_matches" : "integrations.no_plugins" : "integrations.no_packages")} description={t(query ? "integrations.search_hint" : props.library ? "integrations.plugins_import_hint" : "integrations.import_description")} /> : null}
      <div className="space-y-1">
        {visiblePackages.map((plugin) => (
          <IntegrationLibraryRow key={plugin.pluginId} name={pluginImportName(plugin)} description={plugin.description || packageParts(plugin.files.map(file => file.objectType)) || t("extensions.import_no_components")}
            status={plugin.importState?.readiness === "partial" || plugin.importState?.readiness === "unsupported" ? <span className="text-xs text-muted-foreground">{t(plugin.importState.readiness === "partial" ? "extensions.import_partial" : "extensions.import_unsupported")}</span> : connectorState ? <PluginConnectorStatus states={plugin.files.filter(file => file.objectType === "mcp").map(file => connectorState(pluginFileInstalledName(file)))} /> : undefined}
            source={props.library ? plugin.pluginId.startsWith("import:chatgpt:") ? "ChatGPT" : plugin.pluginId.startsWith("import:claude:") ? "Claude" : undefined : undefined}
            icon={<span className="grid size-9 shrink-0 place-items-center rounded-xl border border-border"><Package className="size-4 text-muted-foreground" /></span>} busy={props.busy} onOpen={() => setSelected(plugin)}
            onRemove={props.canRemove === false ? undefined : () => setRemoving(plugin)} />
        ))}
      </div>
      </>}
      {selected ? <PluginDetailsDialog key={selected.pluginId} plugin={selected} busy={props.busy} access={props.detailsAccess} imports={props.imports} onChanged={() => props.onChanged?.(selected.pluginId)} onClose={() => setSelected(null)} /> : null}
      <ConfirmModal
        open={removing !== null}
        title={t("skills.package_remove_title", { name: removing ? pluginImportName(removing) : "" })}
        message={t(removing?.scope === "global" ? "extensions.import_remove_global" : "skills.package_remove_message")}
        confirmLabel={t("skills.package_remove")}
        cancelLabel={t("common.cancel")}
        confirmButtonVariant="destructive"
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          const target = removing;
          setRemoving(null);
          if (target) void remove(target);
        }}
      />
    </div>
  );
}

export function matchingBuiltInSkills(searchQuery = "") {
  const query = searchQuery.trim().toLowerCase();
  return BUILT_IN_SKILLS.filter(skill => !query || [skill.name, skill.description(), ...skill.commands].join(" ").toLowerCase().includes(query));
}

export function BuiltInSkills(props: { searchQuery?: string; showEmpty?: boolean } = {}) {
  const skills = matchingBuiltInSkills(props.searchQuery);
  const [selected, setSelected] = useState<typeof skills[number] | null>(null);
  if (skills.length === 0 && !props.showEmpty) return null;
  return (
    <div className="space-y-4">
      <IntegrationGroupHeading hideInLibrary title={t("skills.built_in_title")} count={skills.length} />
      {skills.length === 0 ? <IntegrationEmptyState icon={Blocks} title={t("integrations.no_skill_matches")} description={t("integrations.search_hint")} /> : null}
      <div className="space-y-1">
        {skills.map((skill) => (
          <IntegrationLibraryRow key={skill.id} name={skill.name} description={skill.description()} source={t("integrations.included")} onOpen={() => setSelected(skill)}
            icon={<span className="grid size-9 shrink-0 place-items-center rounded-xl border border-border"><Blocks className="size-4 text-muted-foreground" /></span>} />
        ))}
      </div>
      <Dialog open={selected !== null} onOpenChange={open => { if (!open) setSelected(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{selected?.name}</DialogTitle><DialogDescription>{selected?.description()}</DialogDescription></DialogHeader>
          <p className="text-sm text-muted-foreground">{t("integrations.skill_commands")}</p>
          <div className="flex flex-wrap gap-2">{selected?.commands.map(command => <code key={command} className="rounded-md bg-muted px-2 py-1 text-sm">{command}</code>)}</div>
          <DialogFooter><Button onClick={() => setSelected(null)}>{t("common.close")}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
