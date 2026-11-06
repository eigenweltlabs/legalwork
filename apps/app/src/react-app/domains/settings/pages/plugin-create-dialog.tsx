import { PluginConnectorFields, emptyPluginConnectorForm, pluginConnectorConfig, type PluginConnectorForm } from "./plugin-connector-fields";
import { useEffect, useRef, useState, type RefObject } from "react";
import { Blocks, Loader2, Plug, Search } from "lucide-react";
import type { PluginCreateOptions, PluginCreateRequest } from "@legalwork/types/plugin-import";
import type { ImportedPlugin } from "@/app/lib/extension-imports";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";
import { pluginImportConnectorName, pluginImportSkillName } from "./plugin-import-presentation";

export type PluginCreateStore = {
  pluginCreateOptions: () => Promise<PluginCreateOptions>;
  createWorkflowPlugin: (input: PluginCreateRequest) => Promise<ImportedPlugin>;
};

export function PluginCreateDialog(props: { store: PluginCreateStore; allowSkills: boolean; allowConnectors: boolean; onClose: () => void; onCreated: (plugin: ImportedPlugin, newConnector: PluginCreateRequest["newConnector"]) => void; returnFocus?: RefObject<HTMLButtonElement | null> }) {
  const [connection, setConnection] = useState<PluginConnectorForm>({ ...emptyPluginConnectorForm, mode: props.allowConnectors ? "remote" : "existing" });
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [query, setQuery] = useState("");
  const [skills, setSkills] = useState<string[]>([]);
  const [connectors, setConnectors] = useState<string[]>([]);
  const [options, setOptions] = useState<PluginCreateOptions | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [revision, setRevision] = useState(0);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    let stopped = false;
    setError("");
    setOptions(null);
    props.store.pluginCreateOptions().then(items => { if (!stopped) setOptions(items); }).catch(cause => { if (!stopped) setError(cause instanceof Error ? cause.message : t("plugin_create.failed")); });
    return () => { stopped = true; };
  }, [props.store, revision]);

  const hasNewConnector = props.allowConnectors && connection.mode !== "existing";
  const selected = skills.length + (hasNewConnector ? 0 : connectors.length);
  const search = query.trim().toLowerCase();
  const groups = [
    { title: t("skills.title"), icon: Blocks, items: props.allowSkills ? (options?.skills ?? []).map(item => ({ ...item, label: pluginImportSkillName(item) })) : [], selected: skills, setSelected: setSkills },
    { title: t("extensions.connectors_label"), icon: Plug, items: props.allowConnectors && !hasNewConnector ? (options?.connectors ?? []).map(item => ({ ...item, label: pluginImportConnectorName(item.name), description: "" })) : [], selected: connectors, setSelected: setConnectors },
  ];
  const hasItems = groups.some(group => group.items.length);
  const hasMatches = groups.some(group => group.items.some(item => `${item.label} ${item.description}`.toLowerCase().includes(search)));
  const validName = name.trim().length > 0;
  const canCreate = validName && (hasNewConnector || selected > 0) && options !== null && !saving;
  const submit = async () => {
    if (!canCreate) return;
    setSaving(true);
    setError("");
    try {
      const newConnector = props.allowConnectors ? pluginConnectorConfig(connection) : undefined;
      const plugin = await props.store.createWorkflowPlugin({ name: name.trim(), description: description.trim(), skills: props.allowSkills ? skills : [], connectors: props.allowConnectors && connection.mode === "existing" ? connectors : [], newConnector });
      if (!active.current) return;
      props.onClose();
      props.onCreated(plugin, newConnector);
    } catch (cause) {
      if (!active.current) return;
      setError(cause instanceof Error ? cause.message : t("plugin_create.failed"));
      setSaving(false);
    }
  };
  return <Dialog open onOpenChange={open => { if (!open && !saving) props.onClose(); }}>
    <DialogContent finalFocus={props.returnFocus} className="flex max-h-[calc(100dvh-3rem)] flex-col overflow-hidden bg-background sm:max-w-xl">
      <DialogHeader><DialogTitle>{t("plugin_create.title")}</DialogTitle><DialogDescription>{t("plugin_create.description")}</DialogDescription></DialogHeader>
      <form className="flex min-h-0 flex-col gap-5" onSubmit={event => { event.preventDefault(); void submit(); }}>
        <div className="min-h-0 space-y-5 overflow-y-auto px-px py-1">
          <label className="block space-y-2 text-sm font-medium">{t("plugin_create.name")}<Input autoFocus value={name} maxLength={80} disabled={saving} onChange={event => setName(event.currentTarget.value)} placeholder={t("plugin_create.name_placeholder")} /></label>

          {props.allowConnectors ? <PluginConnectorFields form={connection} onChange={setConnection} disabled={saving} /> : null}
          <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">{t("plugin_create.summary")}</summary><div className="mt-3"><label className="block space-y-2 text-sm font-medium">{t("plugin_create.summary")}<Textarea value={description} maxLength={1024} disabled={saving} onChange={event => setDescription(event.currentTarget.value)} placeholder={t("plugin_create.summary_placeholder")} rows={2} /></label></div></details>
          <details key={connection.mode === "existing" ? "library" : "new"} open={connection.mode === "existing" ? true : undefined} className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">{t(hasNewConnector ? "plugin_create.optional_skills" : "plugin_create.contents")}{selected > 0 ? ` (${selected})` : ""}</summary>
            <div className="mt-3">
          {options ? <div className="space-y-3">
            <div className="flex items-center justify-between gap-3 text-sm"><h3 className="font-medium">{t(hasNewConnector ? "plugin_create.optional_skills" : "plugin_create.contents")}</h3>{selected > 0 ? <span className="text-muted-foreground">{t("plugin_create.selected", { count: selected })}</span> : null}</div>
            {hasItems ? <div className="relative"><Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input aria-label={t("plugin_create.search")} placeholder={t("plugin_create.search")} value={query} disabled={saving} onChange={event => setQuery(event.currentTarget.value)} className="pl-9" /></div> : null}
            <div className="max-h-64 overflow-y-auto rounded-xl border border-border">
              {!hasMatches ? <p className="p-4 text-sm text-muted-foreground">{t(hasItems ? "plugin_create.no_matches" : "plugin_create.empty")}</p> : groups.map(({ title, icon: Icon, items, selected: checked, setSelected }) => {
                const matches = items.filter(item => `${item.label} ${item.description}`.toLowerCase().includes(search));
                return matches.length ? <section key={title} className="border-b border-border last:border-b-0"><h4 className="px-4 pb-1 pt-3 text-xs font-medium text-muted-foreground">{title}</h4>{matches.map(item => <label key={item.name} className="flex cursor-pointer items-center gap-3 px-4 py-3 hover:bg-muted/50">
                  <Checkbox checked={checked.includes(item.name)} disabled={saving} onCheckedChange={value => setSelected(current => value ? [...current, item.name] : current.filter(name => name !== item.name))} />
                  <Icon className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 text-sm"><span className="block truncate">{item.label}</span>{item.description ? <span className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{item.description}</span> : null}</span>
                </label>)}</section> : null;
              })}
            </div>
            {hasItems ? <p className="text-xs leading-relaxed text-muted-foreground">{t("plugin_create.copy_hint")}</p> : null}
          </div> : error ? <Button type="button" variant="outline" onClick={() => setRevision(value => value + 1)}>{t("common.refresh")}</Button> : <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("common.loading")}</p>}
            </div>
          </details>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        </div>
        <DialogFooter><Button type="button" variant="outline" disabled={saving} onClick={props.onClose}>{t("common.cancel")}</Button><Button type="submit" disabled={!canCreate}>{saving ? <Loader2 className="size-4 animate-spin" /> : null}{t(saving ? "plugin_create.creating" : "plugin_create.submit")}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
