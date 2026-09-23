import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, ChevronDown, Download, Loader2, MoreHorizontal, Pencil, Plus, RefreshCw, Search, Share2, Table2, Trash2, Wand2, Workflow } from "lucide-react";
import type { SkillCard } from "@/app/types";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { ConfirmModal } from "@/react-app/design-system/modals/confirm-modal";
import { EVALS_PANEL_SESSION_ID, useActivePanelTab, usePanelTabStore } from "../../session/panel/panel-tab-store";
import { PANEL_OPEN_TAB_EVENT } from "../../session/panel/panel-tab-request";
import { confirmDiscardDocuments } from "../../session/artifacts/docx-document-state";
import { useUiStateStore } from "@/react-app/shell/ui-state-store";
import { dismissTemplateWorkflowRun, retryTemplateWorkflowImport, useTemplateWorkflowRun } from "../state/template-workflow-generation";
import { bindWorkflowServices, discardWorkflow, openWorkflow, showWorkflow, useWorkflowEditorStore, workflowDirty, type WorkflowDraft } from "../state/workflow-editor-store";
import { isWorkflowCard, workflowDisplayName, workflowType, type WorkflowType } from "../state/workflow-document";
import { ImportSkillsButton, TemplateGenerationRow, type SkillsViewProps } from "./skills-view";
import { LegalQuantsImportButton } from "./legalquants-import";
import { WorkflowEditorPanel } from "./workflow-editor-panel";
import { NewWorkflowDialog } from "./new-workflow-dialog";
import { WORKFLOWS_PER_PAGE, WorkflowPagination } from "./workflow-pagination";
import { useWorkflowResourceStore } from "../state/workflow-resource-store";
import { WorkflowResourceEditorPanel } from "./workflow-resource-editor-panel";

export type WorkflowsViewProps = SkillsViewProps & {
  workspaceId: string;
  /** Settings routes have no app viewer, so host the same editor beside the list. */
  inlineEditor?: boolean;
  extensions: SkillsViewProps["extensions"] & { workspaceContextKey: () => string };
};

const scopes: ("local" | "team")[] = ["local", "team"];

export function WorkflowsView(props: WorkflowsViewProps) {
  const { extensions, workspaceId } = props;
  const [scope, setScope] = useState<"local" | "team">("local");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const [newType, setNewType] = useState<WorkflowType | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [legalQuantsOpen, setLegalQuantsOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<SkillCard | null>(null);
  const [inlineId, setInlineId] = useState<string | null>(null);
  const drafts = useWorkflowEditorStore((state) => state.drafts);
  const inlineResource = useWorkflowResourceStore((state) => inlineId ? state.drafts[inlineId] : undefined);
  const activeTab = useActivePanelTab(EVALS_PANEL_SESSION_ID);
  const panelOpen = useUiStateStore((state) => state.sidePanelState[EVALS_PANEL_SESSION_ID] === "panel");
  const templateRun = useTemplateWorkflowRun();
  const allSkills = extensions.skills();
  const resources = extensions.skillResources();
  const resourceStatus = extensions.skillResourcesStatus();
  const contextKey = extensions.workspaceContextKey();
  const canEdit = props.canInstallSkillCreator;
  const installedNames = useMemo(() => new Set(allSkills.map((skill) => skill.name)), [allSkills]);
  const workflowSkills = allSkills.filter(isWorkflowCard);
  const localDrafts = Object.values(drafts).filter((draft) => draft.workspaceId === workspaceId);
  const newDrafts = localDrafts.filter((draft) => draft.isNew);
  const search = query.trim().toLowerCase();
  const matches = (name: string, description = "") => `${name} ${description}`.toLowerCase().includes(search);
  const filtered = workflowSkills.filter((skill) => {
    const draft = localDrafts.find((item) => item.name === skill.name && !item.isNew);
    return matches(draft?.title || workflowDisplayName(skill.name), draft?.description ?? skill.description);
  });
  const filteredDrafts = newDrafts.filter((draft) => matches(draft.title, draft.description));
  const entries: { skill: SkillCard | null; draft: WorkflowDraft | undefined }[] = [
    ...filteredDrafts.map((draft) => ({ skill: null, draft })),
    ...filtered.map((skill) => ({ skill, draft: localDrafts.find((draft) => !draft.isNew && draft.name === skill.name) })),
  ];
  const lastPage = Math.max(0, Math.ceil(entries.length / WORKFLOWS_PER_PAGE) - 1);
  const currentPage = Math.min(page, lastPage);
  const visibleEntries = entries.slice(currentPage * WORKFLOWS_PER_PAGE, (currentPage + 1) * WORKFLOWS_PER_PAGE);

  useEffect(() => { setPage(0); }, [workspaceId]);
  useEffect(() => { setPage((value) => Math.min(value, lastPage)); }, [lastPage]);
  useEffect(() => { if (listRef.current) listRef.current.scrollTop = 0; }, [currentPage, scope, query]);

  useEffect(() => bindWorkflowServices(workspaceId, {
    extensions, contextKey, currentContextKey: extensions.workspaceContextKey, canEdit, busy: props.busy, resources, resourceStatus,
  }), [workspaceId, extensions, contextKey, canEdit, props.busy, resources, resourceStatus]);

  useEffect(() => {
    if (!props.inlineEditor) return;
    const open = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail: unknown = event.detail;
      if (!detail || typeof detail !== "object") return;
      const type: unknown = Reflect.get(detail, "type");
      if (type !== "workflow" && type !== "workflow-resource") return;
      const id: unknown = Reflect.get(detail, "id");
      if (typeof id !== "string") return;
      const draft = type === "workflow" ? useWorkflowEditorStore.getState().drafts[id] : useWorkflowResourceStore.getState().drafts[id];
      if (draft?.workspaceId === workspaceId) setInlineId((current) => current === id || confirmDiscardDocuments(undefined, undefined, true) ? id : current);
    };
    window.addEventListener(PANEL_OPEN_TAB_EVENT, open);
    return () => window.removeEventListener(PANEL_OPEN_TAB_EVENT, open);
  }, [props.inlineEditor, workspaceId]);

  useEffect(() => {
    let active = true;
    setRefreshing(true);
    void Promise.resolve(extensions.refreshSkills({ force: true })).finally(() => { if (active) setRefreshing(false); });
    return () => { active = false; };
  }, [extensions, workspaceId]);

  useEffect(() => {
    if (templateRun?.status === "done") void extensions.refreshSkills({ force: true });
  }, [extensions, templateRun?.status]);

  const generate = async () => {
    if (!props.onGenerateFromTemplates) return;
    try {
      const result = await props.onGenerateFromTemplates();
      if (!result.ok && result.message) toast.error(result.message);
    } catch (error) { toast.error(error instanceof Error ? error.message : t("common.something_went_wrong")); }
  };

  const start = (type: WorkflowType) => setNewType(type);
  const closeDraft = (id: string) => {
    discardWorkflow(id);
    if (inlineId === id) setInlineId(null);
    const panels = usePanelTabStore.getState();
    for (const [sessionId, session] of Object.entries(panels.sessions)) {
      if (session.tabs.some((tab) => tab.id === id)) panels.closeTab(sessionId, id);
    }
  };
  const row = (skill: SkillCard | null, draft: WorkflowDraft | undefined) => {
    const name = draft?.title || (skill ? workflowDisplayName(skill.name) : t("skills.new_workflow"));
    const description = draft?.description ?? skill?.description ?? "";
    const type = draft?.type ?? (skill ? workflowType(skill) : "assistant");
    const Icon = type === "tabular" ? Table2 : Workflow;
    const selected = props.inlineEditor ? inlineId === draft?.id : panelOpen && activeTab?.type === "workflow" && activeTab.id === draft?.id;
    const open = () => skill ? void openWorkflow(workspaceId, skill) : draft && showWorkflow(draft);
    const menuItems = (context: boolean) => {
      const Item = context ? ContextMenuItem : DropdownMenuItem;
      const Separator = context ? ContextMenuSeparator : DropdownMenuSeparator;
      return <>
        <Item onClick={open}><Pencil />{t("common.edit")}</Item>
        {skill ? <>
          <Item disabled={props.busy || !props.canUseDesktopTools} onClick={() => void extensions.exportSkillZip(skill.name).then((result) => { if (!result.ok) toast.error(result.message); else if (result.message) toast.success(result.message); })}><Download />{t("workflows.export")}</Item>
          {props.canShareWithFirm && props.onShareWithFirm ? <Item disabled={props.busy} onClick={() => void props.onShareWithFirm?.(skill.name, "workflow")}><Share2 />{t("workflows.share")}</Item> : null}
          <Separator />
          <Item variant="destructive" disabled={props.busy || !canEdit || draft?.saving} onClick={() => setRemoveTarget(skill)}><Trash2 />{t("skills.uninstall")}</Item>
        </> : draft ? <>
          <Separator />
          <Item variant="destructive" disabled={draft.saving} onClick={() => { if (confirmDiscardDocuments(draft.id)) closeDraft(draft.id); }}><Trash2 />{t("workflows.discard_draft")}</Item>
        </> : null}
      </>;
    };
    return <ContextMenu key={draft?.id ?? skill?.name}>
      <ContextMenuTrigger render={<div />} className={cn("group flex items-start gap-1 rounded-lg transition-colors hover:bg-muted/50", selected && "bg-muted")}>
      <button type="button" aria-pressed={selected} onClick={open} className="flex min-w-0 flex-1 gap-3 rounded-lg px-3 py-3 text-left focus-visible:outline-2 focus-visible:outline-ring">
        <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1"><span className="flex items-center gap-2 text-[13px] font-medium"><span className="truncate">{name}</span>{draft && workflowDirty(draft) ? <span aria-label={t("common.unsaved_changes")} className="size-1.5 shrink-0 rounded-full bg-foreground/60" /> : null}</span>
          {description ? <span className="mt-1 line-clamp-2 block text-xs leading-5 text-muted-foreground">{description}</span> : null}
          <span className="mt-1.5 block text-[11px] text-muted-foreground">{type === "tabular" ? t("skills.tabular_workflow") : t("skills.assistant_workflow")}{draft?.isNew ? ` · ${t("workflows.draft")}` : ""}</span>
        </span>
      </button>
      <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className="mr-1 mt-2 shrink-0 text-muted-foreground" aria-label={t("workflows.actions", { name })} />}><MoreHorizontal /></DropdownMenuTrigger>
        <DropdownMenuContent align="end">{menuItems(false)}</DropdownMenuContent>
      </DropdownMenu>
      </ContextMenuTrigger>
      <ContextMenuContent>{menuItems(true)}</ContextMenuContent>
    </ContextMenu>;
  };

  const library = <section aria-label={t("skills.workflows_title")} className={cn(
    "@container/workflows flex h-full min-h-0 w-full flex-1 flex-col bg-background",
    !(props.inlineEditor ? inlineId !== null : panelOpen) && "mx-auto max-w-4xl pt-4",
  )}>
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
      <h1 className="sr-only text-[13px] font-semibold @min-[360px]/workflows:not-sr-only">{t("skills.workflows_title")}</h1><span className="hidden text-[11px] tabular-nums text-muted-foreground @min-[480px]/workflows:inline">{workflowSkills.length}</span>
      <div className="flex shrink-0 items-center gap-3 @min-[360px]/workflows:ml-2 @min-[360px]/workflows:border-l @min-[360px]/workflows:border-border @min-[360px]/workflows:pl-3">
        {scopes.filter((value) => value === "local" || props.firmDownloadView).map((value) => <button key={value} type="button" aria-pressed={scope === value} onClick={() => { setScope(value); setPage(0); }} className={cn("text-xs", scope === value ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground")}>{value === "local" ? t("firm_hub.scope_local") : t("firm_hub.scope_team")}</button>)}
      </div>
      <span className="flex-1" />
      {scope === "team" && props.onOpenTeamShare ? <Button variant="ghost" size="icon-sm" aria-label={t("workflows.share")} onClick={props.onOpenTeamShare}><Share2 /></Button> : null}
      <Button variant="ghost" size="icon-sm" aria-label={t("common.refresh")} disabled={props.busy || refreshing} onClick={() => { setRefreshing(true); void Promise.resolve(extensions.refreshSkills({ force: true })).finally(() => setRefreshing(false)); }}><RefreshCw className={refreshing ? "animate-spin" : ""} /></Button>
      <div className="flex shrink-0 items-center gap-0.5">
        <Button size="sm" className="w-8 rounded-r-sm px-0 @min-[480px]/workflows:w-auto @min-[480px]/workflows:px-2.5" aria-label={t("skills.new_workflow")} disabled={props.busy || !canEdit} onClick={() => start("assistant")}><Plus /><span className="hidden @min-[480px]/workflows:inline">{t("skills.new_workflow")}</span></Button>
        <DropdownMenu><DropdownMenuTrigger render={<Button size="icon-sm" className="rounded-l-sm" aria-label={t("workflows.new_options")} disabled={props.busy} />}><ChevronDown /></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled={!canEdit} onClick={() => start("assistant")}><Bot />{t("skills.new_assistant_workflow")}</DropdownMenuItem>
            <DropdownMenuItem disabled={!canEdit} onClick={() => start("tabular")}><Table2 />{t("skills.new_tabular_workflow")}</DropdownMenuItem>
            {props.onGenerateFromTemplates ? <DropdownMenuItem disabled={!canEdit || !props.canUseDesktopTools || templateRun?.status === "running"} onClick={() => void generate()}><Wand2 />{t("skills.generate_from_templates")}</DropdownMenuItem> : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={!canEdit} onClick={() => setImportOpen(true)}><Download />{t("skills.import")}</DropdownMenuItem>
            <DropdownMenuItem disabled={!canEdit} onClick={() => setLegalQuantsOpen(true)}><Download />LegalQuants</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
    {props.accessHint ? <p className="px-4 py-3 text-xs text-muted-foreground">{props.accessHint}</p> : null}
    {scope === "local" ? <>
      <label className="relative mx-4 my-3 block shrink-0"><Search className="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" /><input value={query} onChange={(event) => { setQuery(event.currentTarget.value); setPage(0); }} aria-label={t("workflows.search")} placeholder={t("workflows.search")} className="h-9 w-full rounded-lg border border-input bg-transparent pl-8 pr-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/30" /></label>
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {templateRun ? <div className="mb-2 px-2"><TemplateGenerationRow status={templateRun.status} templatesDir={templateRun.templatesDir} error={templateRun.error} summary={templateRun.summary} onOpen={props.onOpenTemplateGenerationSession} onRetry={retryTemplateWorkflowImport} onDismiss={dismissTemplateWorkflowRun} /></div> : null}
        {visibleEntries.map(({ skill, draft }) => row(skill, draft))}
        {!filtered.length && !filteredDrafts.length ? <div className="flex flex-col items-center gap-3 px-6 py-12 text-center text-xs text-muted-foreground">{refreshing ? <Loader2 className="size-5 animate-spin" /> : <Workflow className="size-5" />}<p>{refreshing ? t("skills.loading") : query ? t("workflows.no_matches") : t("skills.no_workflows")}</p>{!query && !refreshing ? <Button variant="outline" size="sm" disabled={!canEdit} onClick={() => start("assistant")}><Plus />{t("skills.new_workflow")}</Button> : null}</div> : null}
      </div>
      <WorkflowPagination page={currentPage} total={entries.length} onPageChange={setPage} />
    </> : <div className="min-h-0 flex-1 overflow-y-auto p-4">{props.firmDownloadView}</div>}
    {newType ? <NewWorkflowDialog key={`${workspaceId}-${newType}`} workspaceId={workspaceId} type={newType} busy={props.busy || !canEdit} onClose={() => setNewType(null)} onCreated={(draft) => {
      setNewType(null);
      setScope("local");
      setQuery("");
      setPage(Math.floor((newDrafts.length + Math.max(0, extensions.skills().filter(isWorkflowCard).findIndex((skill) => skill.name === draft.name))) / WORKFLOWS_PER_PAGE));
      showWorkflow(draft);
    }} /> : null}
    <ImportSkillsButton open={importOpen} onOpenChange={setImportOpen} asWorkflow busy={props.busy} canUseDesktopTools={props.canUseDesktopTools} existingNames={installedNames} extensions={extensions} />
    <LegalQuantsImportButton open={legalQuantsOpen} onOpenChange={setLegalQuantsOpen} busy={props.busy} existingNames={installedNames} extensions={extensions} className="hidden" />
    <ConfirmModal open={Boolean(removeTarget)} title={t("skills.uninstall_title")} message={t("skills.uninstall_warning").replace("{name}", removeTarget?.name ?? "")} confirmLabel={t("skills.uninstall")} cancelLabel={t("common.cancel")} confirmButtonVariant="destructive" onCancel={() => setRemoveTarget(null)} onConfirm={() => {
      const target = removeTarget; setRemoveTarget(null); if (!target) return;
      const draft = localDrafts.find((entry) => entry.name === target.name);
      if (draft && !confirmDiscardDocuments(draft.id)) return;
      void Promise.resolve(extensions.uninstallSkill(target.name)).then(() => {
        if (!draft || extensions.skills().some((skill) => skill.name === target.name)) return;
        closeDraft(draft.id);
      });
    }} />
  </section>;

  if (!props.inlineEditor) return library;
  return <ResizablePanelGroup orientation="horizontal" className="min-h-[600px] w-full flex-1 overflow-hidden rounded-xl border border-border">
    <ResizablePanel minSize="240px" defaultSize={inlineId ? "40%" : "100%"}>{library}</ResizablePanel>
    {inlineId ? <><ResizableHandle withHandle /><ResizablePanel minSize="320px" defaultSize="60%">{inlineResource
      ? <WorkflowResourceEditorPanel key={inlineId} id={inlineId} onClose={() => { if (confirmDiscardDocuments(inlineId)) setInlineId(inlineResource.workflowId); }} />
      : <WorkflowEditorPanel key={inlineId} id={inlineId} onClose={() => { if (confirmDiscardDocuments(inlineId)) setInlineId(null); }} />}</ResizablePanel></> : null}
  </ResizablePanelGroup>;
}
