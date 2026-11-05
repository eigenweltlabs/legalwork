import { useEffect, useId, useRef, useState, type RefObject } from "react";
import JSZip from "jszip";
import { ArrowLeft, Blocks, Bot, ChevronRight, FileArchive, FolderOpen, Github, Loader2, Package, Plug, RefreshCw, Search, Terminal, TriangleAlert, Workflow } from "lucide-react";
import type { PluginImportCandidate, PluginImportPreview, PluginImportProvider, PluginImportRequest, PluginImportSource, PluginImportScope, PluginImportUpdate } from "@legalwork/types/plugin-import";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { pickDirectory } from "@/app/lib/desktop";
import { LegalworkServerError } from "@/app/lib/legalwork-server";
import { isDesktopRuntime } from "@/app/utils";
import { t } from "@/i18n";
import { ChatGptLogo } from "../../connections/provider-auth/chatgpt-plan-card";
import claudeLogo from "@/assets/claude-logo.svg";
import { HubTabs } from "../segmented-tabs";
import { groupPluginImportCandidates, pluginImportCandidateKey, pluginImportDestination, pluginImportName } from "./plugin-import-presentation";
import { packageParts } from "./plugin-package-contents";
import type { SkillImportSource } from "./skills-view";

export type PluginImportStore = {
  discoverPluginImports(provider: PluginImportProvider): Promise<PluginImportCandidate[]>;
  previewPluginImports(request: PluginImportRequest): Promise<PluginImportPreview[]>;
  installPluginImport(request: PluginImportRequest): Promise<PluginImportPreview>;
  refreshPluginImport(preview: PluginImportPreview): Promise<void>;
  checkPluginImportUpdate?: (pluginId: string) => Promise<PluginImportUpdate>;
  rollbackPluginImport?: (pluginId: string) => Promise<void>;
};

export async function installReviewedPluginImport(store: Pick<PluginImportStore, "installPluginImport" | "previewPluginImports">, request: PluginImportRequest, reviewed: PluginImportPreview, onReview: (items: PluginImportPreview[]) => void): Promise<PluginImportPreview | null> {
  let current = reviewed;
  // Recover rejected reviews only; retrying a timeout could duplicate a saved import.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await store.installPluginImport({ ...request, root: current.root, digest: current.digest, validationId: current.validationId });
    } catch (cause) {
      if (!(cause instanceof LegalworkServerError) || !["connector_review_expired", "plugin_preview_changed"].includes(cause.code)) throw cause;
      const items = await store.previewPluginImports({ ...request, root: current.root, recheck: true });
      onReview(items);
      const fresh = items.find(item => item.root === current.root);
      // Only the server token may change without requiring a new user decision.
      if (!fresh || JSON.stringify({ ...current, validationId: undefined }) !== JSON.stringify({ ...fresh, validationId: undefined })) return null;
      current = fresh;
    }
  }
  return null;
}
const componentTypes: PluginImportPreview["components"][number]["type"][] = ["skill", "mcp", "agent", "command"];
type ImportFilter = "all" | "plugin" | "skill" | "connector";
const componentIcons = { skill: Blocks, mcp: Plug, agent: Bot, command: Terminal };
const sourceStateLabels = { installed: "extensions.import_source_installed", disabled: "extensions.import_source_disabled", available: "extensions.import_source_available", synced: "extensions.import_source_synced" };
const componentLabel = (type: PluginImportPreview["components"][number]["type"]) =>
  t(type === "skill" ? "extensions.import_skill" : type === "mcp" ? "integrations.connector" : type === "agent" ? "composer.agent_label" : "session.permission_detail_command");

/** Skill paths keep a user's selection stable across renames and source updates. */
export function PluginImportWorkflowChoice(props: { preview: PluginImportPreview; available: boolean; busy?: boolean; onEditingChange?: (editing: boolean) => void; onChange: (paths: string[]) => Promise<boolean> }) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const skills = props.preview.components.flatMap(item => item.type === "skill" && item.sourcePath ? [{ ...item, sourcePath: item.sourcePath }] : []);
  const applied = (props.preview.provenance?.workflowSkillPaths ?? skills.filter(item => item.asWorkflow ?? props.preview.provenance?.asWorkflow).map(item => item.sourcePath)).filter(path => skills.some(item => item.sourcePath === path));
  const [selected, setSelected] = useState(applied);
  if (!props.available || pluginImportDestination(props.preview).tab !== "plugins" || !skills.length) return null;
  const edit = (next: boolean) => { setEditing(next); props.onEditingChange?.(next); };
  const apply = async () => { if (await props.onChange(selected)) edit(false); };
  return <section className="overflow-hidden rounded-xl border border-border" aria-labelledby={`${id}-title`}>
    <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
      <h4 id={`${id}-title`} className="text-sm font-medium">{editing ? t("extensions.import_choose_workflows") : packageParts(skills.map(item => item.type))}</h4>
      {editing ? <Button variant="ghost" size="xs" disabled={props.busy} onClick={() => setSelected(selected.length === skills.length ? [] : skills.map(item => item.sourcePath))}>{t(selected.length === skills.length ? "extensions.import_clear_selection" : "skills.select_all")}</Button> : <Button variant="outline" size="sm" onClick={() => { setSelected(applied); edit(true); }}>{applied.length ? <Workflow /> : <Blocks />}{t(applied.length ? "extensions.import_change_selection" : "extensions.import_convert_skills")}</Button>}
    </div>
    {editing ? <p className="px-4 pb-3 text-xs text-muted-foreground">{t("extensions.import_unselected_skills")}</p> : null}
    <ul className="max-h-64 overflow-y-auto border-t border-border px-2 py-1">
      {skills.map((item, index) => <li key={item.sourcePath}>
        <label htmlFor={`${id}-${index}`} className={`flex items-center gap-3 rounded-lg px-2 py-2 text-sm ${editing ? "cursor-pointer hover:bg-muted/50" : ""}`}>
          {editing ? <Checkbox id={`${id}-${index}`} checked={selected.includes(item.sourcePath)} disabled={props.busy} onCheckedChange={checked => setSelected(current => checked ? [...current, item.sourcePath] : current.filter(path => path !== item.sourcePath))} /> : applied.includes(item.sourcePath) ? <Workflow className="size-4 shrink-0 text-muted-foreground" /> : <Blocks className="size-4 shrink-0 text-muted-foreground" />}
          <span className="min-w-0 flex-1 break-words">{pluginImportName(item)}</span>
          {!editing ? <span className="text-xs text-muted-foreground">{t(applied.includes(item.sourcePath) ? "workflows.workflow" : "extensions.import_skill")}</span> : null}
        </label>
      </li>)}
    </ul>
    {editing ? <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3">
      <p role="status" className="text-xs text-muted-foreground">{t("extensions.import_workflows_selected", { count: selected.length })}</p>
      <div className="flex gap-2"><Button variant="ghost" size="sm" disabled={props.busy} onClick={() => edit(false)}>{t("common.cancel")}</Button><Button size="sm" disabled={props.busy} onClick={() => void apply()}>{props.busy ? <Loader2 className="animate-spin" /> : null}{t("extensions.import_apply_selection")}</Button></div>
    </div> : null}
  </section>;
}

/** Routine checks belong in details; only import decisions interrupt the review. */
export function PluginImportChecks(props: { preview: PluginImportPreview; name: string; needsCheck: boolean; importable: boolean; onCheck: () => void; technical?: boolean }) {
  const connectors = (props.preview.connectors ?? []).filter(check => Boolean(props.technical) === (check.status === "compatible" || check.status === "setup"));
  const requirements = (props.preview.requirements ?? []).filter(item => Boolean(props.technical) === (item.status === "satisfied" || item.status === "setup"));
  const canRecheck = props.technical ? (props.preview.connectors?.length ?? 0) > 0 : props.needsCheck || connectors.some(check => check.retryable);
  if (!connectors.length && !requirements.length && !canRecheck) return null;
  const blocked = connectors.some(check => check.status === "blocked") || requirements.some(item => item.required && item.status === "blocked");
  return <div role={props.technical ? undefined : "status"} className={props.technical ? "space-y-3" : "space-y-3 rounded-xl border border-border p-4"}>
    {!props.technical ? <h4 className="text-sm font-medium">{t(blocked ? props.importable ? "extensions.import_not_included" : "extensions.import_connection_blocked" : requirements.length ? "extensions.import_not_included" : "extensions.import_connection_unchecked")}</h4> : null}
    {requirements.map((item, index) => <div key={`${item.code}:${index}`} className="space-y-1">
      {item.name.toLocaleLowerCase() !== props.name.toLocaleLowerCase() ? <p className="text-sm font-medium">{item.name}</p> : null}
      <p className="text-sm leading-relaxed text-muted-foreground">{item.message}</p>
    </div>)}
    {connectors.map(check => <div key={check.installedName} className="space-y-1 text-sm">
      {props.technical || pluginImportName(check).toLocaleLowerCase() !== props.name.toLocaleLowerCase() ? <p className="font-medium">{pluginImportName(check)}</p> : null}
      <p className="leading-relaxed text-muted-foreground">{check.message}</p>
      {check.inputs?.length ? <p className="text-xs text-muted-foreground">{t("extensions.import_required_values", { values: check.inputs.join(", ") })}</p> : null}
      {check.documentationUrl ? <a href={check.documentationUrl} target="_blank" rel="noreferrer" className="text-xs underline underline-offset-4">{t("extensions.import_provider_requirements")}</a> : null}
    </div>)}
    {canRecheck ? <Button variant="outline" size="sm" onClick={props.onCheck}><RefreshCw />{t(props.needsCheck ? "extensions.import_check" : "extensions.import_check_again")}</Button> : null}
  </div>;
}

export function PluginImportDialog(props: { store: PluginImportStore; onClose: () => void; onImported: (preview: PluginImportPreview) => void | Promise<void>; onImportSkills?: (source: SkillImportSource) => void | Promise<void>; onImportLegalQuants?: () => void; canImportSkills?: boolean; canImportLocalSkills?: boolean; canImportPlugins?: boolean; returnFocus?: RefObject<HTMLElement | null>; initialSource?: PluginImportSource; initialRoot?: string; initialAsWorkflow?: boolean; initialConvertPluginSkills?: boolean; initialWorkflowSkillPaths?: string[] }) {
  const [provider, setProvider] = useState<PluginImportProvider | null>(props.initialSource?.provider || null);
  const [sourceMode, setSourceMode] = useState<"files" | "github" | null>(null);
  const [candidates, setCandidates] = useState<PluginImportCandidate[]>([]);
  const [discovering, setDiscovering] = useState(true);
  const [discoveryFailed, setDiscoveryFailed] = useState(false);
  const [discoveryRevision, setDiscoveryRevision] = useState(0);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ImportFilter>("all");
  const [step, setStep] = useState<"choose" | "review">("choose");
  const [source, setSource] = useState<PluginImportSource | null>(null);
  const [sourceLabel, setSourceLabel] = useState("");
  const [copies, setCopies] = useState<PluginImportCandidate[]>([]);
  const [previews, setPreviews] = useState<PluginImportPreview[]>([]);
  const [selectedRoot, setSelectedRoot] = useState("");
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [choosingWorkflows, setChoosingWorkflows] = useState(false);
  const [editingWorkflows, setEditingWorkflows] = useState(false);
  const [installed, setInstalled] = useState<PluginImportPreview | null>(null);
  const scope = "global";
  const [acknowledgePartial, setAcknowledgePartial] = useState(false);
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const zipInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const providerButton = useRef<HTMLButtonElement>(null);
  const selected = previews.find(item => item.root === selectedRoot);
  const excluded = selected?.connectors?.filter(check => check.status === "blocked") ?? [];
  const needsCheck = Boolean((selected?.connectors?.length || selected?.provenance) && !selected.validationId);
  const importable = selected !== undefined && selected.components.length > 0 && !needsCheck && selected.readiness !== "unsupported";
  const singleComponent = selected?.components.length === 1 ? selected.components[0] : undefined;
  const destination = selected ? pluginImportDestination(selected) : null;
  const wholePlugin = destination?.tab === "plugins";
  const skillsAsWorkflows = selected?.provenance?.asWorkflow === true && selected.components.filter(item => item.type === "skill").every(item => item.asWorkflow ?? true);
  const choosePluginWorkflows = Boolean(props.initialAsWorkflow && !props.initialSource && !installed && wholePlugin && selected?.components.some(item => item.type === "skill" && item.sourcePath));
  const reviewComponents = selected?.components.filter(item => !choosePluginWorkflows || item.type !== "skill") ?? [];
  const workflowOptions = (provenance?: PluginImportPreview["provenance"]) => ({ asWorkflow: props.initialAsWorkflow, workflowSkillsOnly: Boolean(props.initialAsWorkflow && !props.initialSource), convertPluginSkills: provenance?.convertPluginSkills ?? props.initialConvertPluginSkills, workflowSkillPaths: provenance?.workflowSkillPaths ?? props.initialWorkflowSkillPaths });
  const compactReview = step === "review" && (busy || selected !== undefined && selected.components.length <= 1);
  const ReviewIcon = selected?.format === "connectors" ? Plug : singleComponent && !wholePlugin ? componentIcons[singleComponent.type] : Package;
  const packageName = selected ? pluginImportName(selected) : "";
  const componentName = singleComponent ? pluginImportName(singleComponent) : "";
  const differentComponentName = singleComponent !== undefined && componentName.toLocaleLowerCase() !== packageName.toLocaleLowerCase();
  const reviewName = differentComponentName && !wholePlugin ? componentName : packageName;
  const groups = groupPluginImportCandidates(candidates);
  const search = query.trim().toLocaleLowerCase();
  const narrowed = search.length > 0 || filter !== "all";
  const filtered = groups.filter(({ candidate }) =>
    (filter === "all" || (candidate.kind ?? "plugin") === filter) &&
    [pluginImportName(candidate), candidate.name, candidate.description, candidate.bundledIn?.name, candidate.bundledIn ? pluginImportName(candidate.bundledIn) : undefined].some(value => value?.toLocaleLowerCase().includes(search)));

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    if (!provider || sourceMode) return;
    let cancelled = false;
    setDiscovering(true);
    setDiscoveryFailed(false);
    props.store.discoverPluginImports(provider)
      .then(items => { if (!cancelled) setCandidates(items); })
      .catch(() => { if (!cancelled) setDiscoveryFailed(true); })
      .finally(() => { if (!cancelled) setDiscovering(false); });
    return () => { cancelled = true; };
  }, [provider, props.store, discoveryRevision, sourceMode]);

  useEffect(() => {
    setCandidates([]);
    setPreviews([]);
    setInstalled(null);
    setSource(null);
    setError(null);
    setQuery("");
    setFilter("all");
    if (provider) searchInput.current?.focus();
    else providerButton.current?.focus();
  }, [provider]);

  const preview = async (nextSource: PluginImportSource, label: string) => {
    setAcknowledgePartial(false);
    setInstalled(null);
    setBusy(true);
    setError(null);
    setPreviews([]);
    setSource(null);
    setSourceLabel(label);
    setStep("review");
    try {
      const items = await props.store.previewPluginImports({ source: nextSource, scope, detectFormat: true, ...workflowOptions(), ...(props.initialSource === nextSource ? { root: props.initialRoot } : {}) });
      if (!mounted.current) return;
      if (!items.length) throw new Error(t("extensions.import_failed"));
      setSource(nextSource);
      setPreviews(items);
      setSelectedRoot(items[0].root);
    } catch (cause) {
      if (mounted.current) { setError(cause instanceof Error ? cause.message : t("extensions.import_failed")); setStep("choose"); }
    } finally { if (mounted.current) setBusy(false); }
  };

  useEffect(() => { if (props.initialSource) void preview(props.initialSource, "url" in props.initialSource ? props.initialSource.url : "path" in props.initialSource ? props.initialSource.path : ""); }, [props.initialSource]);

  const chooseFolder = async () => {
    if (!provider) return;
    if (!isDesktopRuntime()) { folderInput.current?.click(); return; }
    try {
      const folder = await pickDirectory({ title: t("extensions.import_choose_folder") });
      if (typeof folder === "string") {
        setCopies([]);
        await preview({ provider, path: folder }, folder.split(/[\\/]/).pop() || t("extensions.import_unnamed"));
      }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : t("extensions.import_failed")); }
  };

  const upload = async (files: FileList | null, folder: boolean) => {
    if (!provider || !files?.length) return;
    const entries = Array.from(files);
    const label = entries[0].name;
    setBusy(true);
    setStep("review");
    setError(null);
    setPreviews([]);
    setSource(null);
    setCopies([]);
    setInstalled(null);
    setSourceLabel(label);
    try {
      if (entries.length > 5000 || entries.reduce((sum, file) => sum + file.size, 0) > 64 * 1024 * 1024) throw new Error(t("extensions.import_size_limit"));
      let zipBase64: string;
      if (folder) {
        const zip = new JSZip();
        for (const file of entries) zip.file(file.webkitRelativePath || file.name, await file.arrayBuffer());
        zipBase64 = await zip.generateAsync({ type: "base64", compression: "DEFLATE" });
      } else {
        const bytes = new Uint8Array(await entries[0].arrayBuffer());
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        zipBase64 = btoa(binary);
      }
      if (mounted.current) await preview({ provider, zipBase64, filename: label }, label);
    } catch (cause) {
      if (mounted.current) { setError(cause instanceof Error ? cause.message : t("extensions.import_failed")); setBusy(false); setStep("choose"); }
    }
  };

  const install = async () => {
    if (!source || !selected || choosingWorkflows) return;
    setInstalling(true);
    setError(null);
    try {
      const result = installed ?? await installReviewedPluginImport(props.store, { source, scope, detectFormat: true, ...workflowOptions(selected.provenance), acknowledgePartial }, selected, items => {
        if (!mounted.current) return;
        setPreviews(items);
        setSelectedRoot(items.find(item => item.root === selected.root)?.root ?? items[0]?.root ?? "");
      });
      if (!result) {
        if (mounted.current) { setAcknowledgePartial(false); toast.info(t("extensions.import_review_updated")); }
        return;
      }
      setInstalled(result);
      await props.store.refreshPluginImport(result);
      await props.onImported(result);
      toast.success(t(selected.format === "connectors" ? "extensions.import_connector_success" : "extensions.import_success", { name: pluginImportName(selected) }));
      props.onClose();
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : t("extensions.import_failed")); }
    finally { if (mounted.current) setInstalling(false); }
  };

  const checkPackage = async (root: string, recheck = false, workflowSkillPaths?: string[]) => {
    if (!source || choosingWorkflows) return false;
    const setChecking = workflowSkillPaths === undefined ? setBusy : setChoosingWorkflows;
    if (workflowSkillPaths === undefined) setEditingWorkflows(false);
    setSelectedRoot(root);
    setChecking(true);
    setInstalled(null);
    setError(null);
    try {
      const checked = await props.store.previewPluginImports({ source, scope, detectFormat: true, ...workflowOptions(previews.find(item => item.root === root)?.provenance), ...(workflowSkillPaths !== undefined ? { convertPluginSkills: true, workflowSkillPaths } : {}), root, recheck });
      if (!checked.some(item => item.root === root)) throw new Error(t("extensions.import_failed"));
      if (mounted.current) { setPreviews(items => items.map(item => checked.find(result => result.root === item.root) ?? item)); setAcknowledgePartial(false); }
      return true;
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : t("extensions.import_failed")); return false; }
    finally { if (mounted.current) setChecking(false); }
  };

  return <Dialog open onOpenChange={open => { if (!open && !installing) props.onClose(); }}>
    <DialogContent className={provider ? `flex max-h-[calc(100dvh-3rem)] flex-col gap-0 bg-background p-0 ${compactReview ? "sm:max-w-md" : "sm:max-w-2xl"}` : "bg-background"} showCloseButton={!installing} finalFocus={props.returnFocus}>
      {provider === null ? <>
        <DialogHeader className="pe-6"><DialogTitle>{t("integrations.import_title")}</DialogTitle><DialogDescription>{t(props.initialAsWorkflow ? "integrations.import_workflow_description" : "integrations.import_choose_provider")}</DialogDescription></DialogHeader>
        <div className="space-y-3">
          <Button ref={providerButton} autoFocus variant="outline" className="h-auto w-full justify-between gap-4 px-4 py-4" disabled={props.canImportPlugins === false} onClick={() => setProvider("chatgpt")}><span className="flex items-center gap-3"><ChatGptLogo className="size-6 shrink-0" />{t("extensions.import_chatgpt")}</span><ChevronRight className="size-4 text-muted-foreground" /></Button>
          <Button variant="outline" className="h-auto w-full justify-between gap-4 px-4 py-4" disabled={props.canImportPlugins === false} onClick={() => setProvider("claude")}><span className="flex items-center gap-3"><img src={claudeLogo} alt="" aria-hidden="true" width={24} height={24} className="size-6 shrink-0" />{t("extensions.import_claude")}</span><ChevronRight className="size-4 text-muted-foreground" /></Button>
          {props.onImportSkills ? <>
            <Button variant="outline" className="h-auto w-full justify-between gap-4 px-4 py-4" disabled={!props.canImportSkills} onClick={() => { if (props.canImportPlugins === false) void props.onImportSkills?.("github"); else { setSourceMode("github"); setProvider("claude"); } }}><span className="flex items-center gap-3"><Github className="size-6 shrink-0" />{t("integrations.import_github")}</span><ChevronRight className="size-4 text-muted-foreground" /></Button>
            <Button variant="outline" className="h-auto w-full justify-between gap-4 px-4 py-4" disabled={!props.canImportLocalSkills} onClick={() => { if (props.canImportPlugins === false) void props.onImportSkills?.("files"); else { setSourceMode("files"); setProvider("claude"); } }}><span className="flex items-center gap-3"><FolderOpen className="size-6 shrink-0" />{t("integrations.import_files")}</span><ChevronRight className="size-4 text-muted-foreground" /></Button>
          </> : null}
          {props.onImportLegalQuants ? <Button variant="outline" className="h-auto w-full justify-between gap-4 px-4 py-4" disabled={!props.canImportSkills} onClick={props.onImportLegalQuants}><span className="flex items-center gap-3"><Workflow className="size-6 shrink-0" />{t("integrations.import_legalquants")}</span><ChevronRight className="size-4 text-muted-foreground" /></Button> : null}
        </div>
      </> : <>
      <DialogHeader className="shrink-0 px-6 pb-4 pt-6">
        {step === "choose" ? <Button variant="link" size="xs" className="mb-2 w-fit px-0 text-muted-foreground" disabled={busy} onClick={() => { setSourceMode(null); setProvider(null); }}><ArrowLeft className="size-3.5" />{t(sourceMode ? "common.back" : "integrations.change_import_provider")}</Button> : null}
        <div className="mb-1 flex items-center gap-2.5 pe-8">
          {sourceMode ? sourceMode === "files" ? <FolderOpen className="size-6 shrink-0" /> : <Github className="size-6 shrink-0" /> : provider === "chatgpt" ? <ChatGptLogo className="size-6 shrink-0" /> : <img src={claudeLogo} alt="" className="size-6 shrink-0" />}
          <DialogTitle>{t(sourceMode === "files" ? "integrations.import_files" : sourceMode === "github" ? "integrations.import_github" : provider === "chatgpt" ? "extensions.import_chatgpt" : "extensions.import_claude")}</DialogTitle>
        </div>
        <DialogDescription className={step === "review" ? "sr-only" : undefined}>{t(step === "choose" ? "extensions.import_description" : "extensions.import_review_description")}</DialogDescription>
      </DialogHeader>

      <div className="flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto px-6 pb-5 [overflow-wrap:anywhere]">
        {installing ? <div className="flex min-h-48 flex-col items-center justify-center gap-3 py-6 text-center" role="status" aria-live="polite">
          <Loader2 className="size-6 animate-spin text-muted-foreground motion-reduce:animate-none" />
          <p className="font-medium">{t(installed ? "extensions.import_finishing" : "extensions.import_installing", { name: packageName })}</p>
          <p className="max-w-xs text-sm leading-relaxed text-muted-foreground">{t("extensions.import_finishing_detail")}</p>
        </div> : step === "choose" ? <>
          {sourceMode ? null : <>
          <div className="flex items-center justify-between gap-3">
            <h3 className="flex items-center gap-2 font-medium">{t("extensions.import_found")}{!discovering && !discoveryFailed ? <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground">{groups.length}</span> : null}</h3>
            <Button variant="ghost" size="icon-sm" disabled={discovering} aria-label={t("extensions.import_rescan")} title={t("extensions.import_rescan")} onClick={() => setDiscoveryRevision(value => value + 1)}><RefreshCw className={discovering ? "animate-spin motion-reduce:animate-none" : ""} /></Button>
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input ref={searchInput} autoFocus className="ps-9" aria-label={t("extensions.import_search")} placeholder={t("extensions.import_search")} value={query} onChange={event => setQuery(event.target.value)} />
          </div>
          <HubTabs<ImportFilter>
            label={t("extensions.import_filter")}
            items={[
              { id: "all", label: t("extensions.filter_all") },
              { id: "plugin", label: t("extensions.filter_plugins") },
              { id: "skill", label: t("skills.title") },
              { id: "connector", label: t("extensions.connectors_label") },
            ]}
            value={filter}
            onChange={setFilter}
          />
          <div className="h-72 min-h-28 overflow-y-auto rounded-xl border border-border">
            {discovering ? <div className="flex h-full items-center justify-center gap-2 text-muted-foreground" role="status"><Loader2 className="size-4 animate-spin motion-reduce:animate-none" />{t("extensions.import_discovering")}</div>
              : discoveryFailed ? <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center"><TriangleAlert className="size-6 text-muted-foreground" /><p className="text-muted-foreground">{t("extensions.import_discovery_failed")}</p><Button variant="outline" size="sm" onClick={() => setDiscoveryRevision(value => value + 1)}>{t("extensions.import_retry")}</Button></div>
              : filtered.length ? <div className="divide-y divide-border">{filtered.map(group => {
                const item = group.candidate;
                const Icon = item.kind === "connector" ? Plug : item.kind === "skill" ? Blocks : Package;
                return <Button key={pluginImportCandidateKey(item)} variant="ghost" className="h-auto w-full justify-start gap-3 rounded-none px-4 py-3 text-start font-normal" onClick={() => { setCopies(group.sources); void preview({ provider, path: item.path, connector: item.connector, marketplace: item.marketplace }, pluginImportName(item)); }}>
                  <Icon className="size-5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1"><span className="block truncate font-medium text-foreground">{pluginImportName(item)}</span><span className="mt-0.5 block truncate text-xs text-muted-foreground">{item.bundledIn ? t("extensions.import_bundled_connector", { name: pluginImportName(item.bundledIn) }) : item.description || t(item.kind === "skill" ? "extensions.import_skill" : item.kind === "connector" ? "integrations.connector" : "extensions.import_plugin")}</span></span>
                  {item.version ? <span className="max-w-24 truncate text-xs text-muted-foreground">{item.version}</span> : null}
                  {item.state ? <span className="text-xs text-muted-foreground">{t(sourceStateLabels[item.state])}</span> : null}
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </Button>;
              })}</div> : <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center"><Package className="size-6 text-muted-foreground" /><p className="font-medium">{t(narrowed ? "extensions.import_no_matches" : "extensions.import_none_found")}</p><p className="text-sm text-muted-foreground">{t(narrowed ? "extensions.import_search_hint" : "extensions.import_file_hint")}</p></div>}
          </div>
          </>}
          {sourceMode === "github" ? null : <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-sm text-muted-foreground">{t("extensions.import_file_source")}</span>
            <div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => void chooseFolder()}><FolderOpen />{t("extensions.import_choose_folder")}</Button><Button variant="outline" size="sm" onClick={() => zipInput.current?.click()}><FileArchive />{t("extensions.import_choose_zip")}</Button></div>
          </div>}
          {sourceMode === "files" ? null : <div className="flex items-center gap-2"><Input aria-label={t("extensions.import_repository_url")} placeholder="https://github.com/owner/repository" value={repositoryUrl} onChange={event => setRepositoryUrl(event.target.value)} /><Button variant="outline" disabled={!repositoryUrl.trim()} onClick={() => void preview({ provider, url: repositoryUrl.trim() }, repositoryUrl.trim())}>{t("extensions.import_review")}</Button></div>}
        </> : busy ? <div className="flex min-h-40 flex-col items-center justify-center gap-3 text-center" role="status"><Loader2 className="size-6 animate-spin text-muted-foreground motion-reduce:animate-none" /><p className="font-medium">{t("extensions.import_reading", { name: sourceLabel })}</p><p className="text-sm text-muted-foreground">{t("extensions.import_working")}</p></div> : selected ? <>
          {previews.length > 1 ? <div className="space-y-2"><p className="text-sm text-muted-foreground">{t("extensions.import_select_package")}</p><div className="flex flex-wrap gap-2">{previews.map(item => <Button key={item.root} size="sm" variant={selectedRoot === item.root ? "secondary" : "outline"} disabled={installing || choosingWorkflows} aria-pressed={selectedRoot === item.root} onClick={() => void checkPackage(item.root)}>{pluginImportName(item)}</Button>)}</div></div> : null}
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border text-muted-foreground"><ReviewIcon className="size-5" /></div>
              <div className="min-w-0 space-y-0.5">
                <h3 className="break-words text-base font-medium">{reviewName}</h3>
                <p className="text-sm text-muted-foreground">{selected.format === "connectors" ? t("integrations.connector") : wholePlugin && selected.components.length ? <>{t("extensions.import_plugin")}{singleComponent ? ` · ${packageParts([singleComponent.type], skillsAsWorkflows)}` : ""}</> : singleComponent ? skillsAsWorkflows && singleComponent.type === "skill" ? t("workflows.workflow") : componentLabel(singleComponent.type) : t("extensions.import_no_components")}</p>
              </div>
            </div>
            {selected.description && selected.format !== "connectors" ? <p className="line-clamp-3 text-sm leading-relaxed text-muted-foreground">{selected.description}</p> : null}
            {wholePlugin && differentComponentName && !choosePluginWorkflows ? <p className="text-sm text-muted-foreground">{componentName}</p> : null}
            {selected.readiness === "setup" && !destination?.connectorName ? <p className="text-sm text-muted-foreground">{t("extensions.import_setup")}</p> : null}
          </div>
          <PluginImportWorkflowChoice preview={selected} available={choosePluginWorkflows} busy={choosingWorkflows} onEditingChange={setEditingWorkflows} onChange={paths => checkPackage(selected.root, false, paths)} />
          <PluginImportChecks preview={selected} name={reviewName} needsCheck={needsCheck} importable={importable} onCheck={() => void checkPackage(selected.root, true)} />
          {selected.readiness === "partial" ? <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={acknowledgePartial} onChange={event => setAcknowledgePartial(event.target.checked)} className="mt-1" />{t("extensions.import_accept_partial")}</label> : null}
          {selected.components.length > 1 && reviewComponents.length ? <div className="max-h-80 overflow-y-auto rounded-xl border border-border divide-y divide-border">
            {componentTypes.flatMap(type => {
              const items = reviewComponents.filter(item => item.type === type);
              const isWorkflow = (item: PluginImportPreview["components"][number]) => item.asWorkflow ?? selected.provenance?.asWorkflow === true;
              const groups = type === "skill" ? [items.filter(isWorkflow), items.filter(item => !isWorkflow(item))] : [items];
              return groups.filter(items => items.length > 0).map(items => {
                const workflows = type === "skill" && isWorkflow(items[0]);
                const Icon = workflows ? Workflow : componentIcons[type];
                return <div key={`${type}:${workflows}`} className="px-4 py-3"><h4 className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground"><Icon className="size-4" />{packageParts(items.map(item => item.type), workflows)}</h4><ul className="space-y-1.5 ps-6">{items.map(item => <li key={item.installedName} className="break-words text-sm">{pluginImportName(item)}</li>)}</ul></div>;
              });
            })}
          </div> : null}
          {selected.warnings.length === 1 ? <div className="flex items-start gap-2 rounded-xl border border-border bg-muted/30 px-3 py-2.5"><TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-11" /><p className="text-sm leading-relaxed text-muted-foreground">{selected.warnings[0]}</p></div> : selected.warnings.length > 1 ? <details className="rounded-xl border border-border bg-muted/30 px-4 py-3"><summary className="cursor-pointer text-sm font-medium"><span className="inline-flex items-center gap-2"><TriangleAlert className="size-4 text-amber-11" />{t("extensions.import_compatibility", { count: selected.warnings.length })}</span></summary><ul className="mt-3 list-disc space-y-2 ps-5 text-sm leading-relaxed text-muted-foreground">{selected.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul></details> : null}
          <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">{t("extensions.import_details")}</summary><div className="mt-3 space-y-3 rounded-lg bg-muted/30 p-3"><p className="break-all text-xs text-muted-foreground">{source && "path" in source ? source.path : sourceLabel}</p><PluginImportChecks preview={selected} name={reviewName} needsCheck={needsCheck} importable={importable} onCheck={() => void checkPackage(selected.root, true)} technical />{selected.version ? <p className="text-xs text-muted-foreground">{t("extensions.import_version", { version: selected.version })}</p> : null}<p className="text-xs text-muted-foreground">{t("extensions.import_file_count", { count: selected.fileCount })} · {(selected.bytes / 1024 / 1024).toFixed(1)} MB</p><p className="text-xs leading-relaxed text-muted-foreground">{t(source && "path" in source && source.connector?.pluginRoot !== undefined ? "extensions.import_bundled_connector_resources" : selected.format === "connectors" ? "extensions.import_connector_resources" : "extensions.import_resources")}</p>{copies.length > 1 ? <div className="space-y-2"><p className="text-xs font-medium">{t("extensions.import_other_copies")}</p>{copies.map(copy => <Button key={pluginImportCandidateKey(copy)} variant="outline" size="sm" className="h-auto w-full justify-start whitespace-normal text-start" disabled={installing} aria-pressed={source !== null && "path" in source && source.path === copy.path} onClick={() => void preview({ provider, path: copy.path, connector: copy.connector, marketplace: copy.marketplace }, pluginImportName(copy))}><span className="min-w-0"><span className="block">{copy.version || pluginImportName(copy)}</span><span className="block break-all text-xs text-muted-foreground">{copy.path}</span></span></Button>)}</div> : null}</div></details>
        </> : null}
        {error ? <div role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</div> : null}
      </div>

      <input ref={zipInput} type="file" accept=".zip,.plugin,application/zip" className="hidden" aria-label={t("extensions.import_choose_zip")} onChange={event => { void upload(event.target.files, false); event.target.value = ""; }} />
      <input ref={element => { folderInput.current = element; element?.setAttribute("webkitdirectory", ""); }} type="file" multiple className="hidden" aria-label={t("extensions.import_choose_folder")} onChange={event => { void upload(event.target.files, true); event.target.value = ""; }} />
      {step === "review" ? <DialogFooter className="mx-0 mb-0 shrink-0 flex-row items-center justify-between gap-3 px-6 py-4 sm:justify-between">
        <Button variant="ghost" disabled={busy || installing || choosingWorkflows} onClick={() => { setStep("choose"); setEditingWorkflows(false); setError(null); }}><ArrowLeft />{t("common.back")}</Button><Button disabled={busy || installing || choosingWorkflows || editingWorkflows || !importable || !source || selected?.readiness === "partial" && !acknowledgePartial} aria-busy={installing} onClick={() => void install()}>{installing ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : null}{t(installing ? "extensions.import_installing" : installed ? "extensions.import_retry" : excluded.length && importable ? "extensions.import_supported_items" : props.initialSource ? "extensions.import_update" : destination?.connectorName && importable ? "extensions.import_and_setup" : "extensions.import_install", { name: packageName })}</Button>
      </DialogFooter> : null}
      </>}
    </DialogContent>
  </Dialog>;
}
