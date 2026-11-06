import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, Blocks, BookOpen, Download, FolderOpen, Loader2, Pencil, Plus, Share2, Trash2, Wand2, Workflow } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { ReviewPromptLibrary } from "../../reviews/review-prompt-library";
import type { SkillCard } from "@/app/types";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { ConfirmModal } from "@/react-app/design-system/modals/confirm-modal";
import { SectionHeading } from "@/react-app/design-system/surface";
import { useActivePanelTab, usePanelTabStore } from "../../session/panel/panel-tab-store";
import { discardDocumentsThen } from "../../session/artifacts/docx-document-state";
import { useUiStateStore } from "@/react-app/shell/ui-state-store";
import { dismissTemplateWorkflowRun, retryTemplateWorkflowImport, useTemplateWorkflowRun } from "../state/template-workflow-generation";
import { bindWorkflowServices, discardWorkflow, openWorkflow, showWorkflow, useWorkflowEditorStore, workflowDirty, type WorkflowDraft } from "../state/workflow-editor-store";
import { isWorkflowCard, workflowDisplayName, type WorkflowType } from "../state/workflow-document";
import { ImportSkillsButton, SkillsView, TemplateGenerationRow, type SkillsViewProps } from "./skills-view";
import { LegalQuantsImportButton } from "./legalquants-import";
import { HubTabs } from "../segmented-tabs";
import { HubScopeContext } from "./hub-scope-context";
import { NewWorkflowDialog } from "./new-workflow-dialog";
import { WORKFLOWS_PER_PAGE, WorkflowPagination } from "./workflow-pagination";
import { FirmSkillDialog } from "./firm-skill-dialog";
import { onSyncPoke } from "@/react-app/kernel/sync-events";
import { IntegrationAddMenu, IntegrationEmptyState, IntegrationLibraryActions, IntegrationLibraryLayoutContext, IntegrationLibraryPage, IntegrationLibraryRow, IntegrationLibrarySearchContext, IntegrationMoreMenu, IntegrationSearch, IntegrationSourceFilter, type IntegrationLibrarySource } from "./integration-library";
import { pluginImportSkillName } from "./plugin-import-presentation";

import { workflowsPanelKey } from "../../session/panel/panel-scope";
import { WorkflowsWorkspace } from "./workflows-workspace";

export type WorkflowsViewProps = SkillsViewProps & {
  active?: boolean;
  workspaceId: string;
  reviewClient?: LegalworkServerClient | null;
  reviewWorkspaceId?: string | null;
  /** The prompt sets the firm shares, included in All and Team. */
  firmReviewSetsView?: ReactNode;
  /** Share one of the user's own prompt sets, or pick some, with the firm. */
  onShareReviewSet?: (id: string) => void;
  onOpenReviewSetShare?: () => void;
  onManagePlugins?: () => void;
  initialSection?: "workflows" | "prompts" | "skills";
  onSectionChange?: (section: "workflows" | "prompts" | "skills") => void;
  firmSkillsView?: ReactNode;
  extensions: SkillsViewProps["extensions"] & { workspaceContextKey: () => string };
};

export function WorkflowsView(props: WorkflowsViewProps) {
  const { extensions, workspaceId } = props;
  const [section, setSection] = useState<"workflows" | "prompts" | "skills">(props.initialSection ?? "workflows");
  useEffect(() => setSection(props.initialSection ?? "workflows"), [props.initialSection]);
  const [source, setSource] = useState<IntegrationLibrarySource>("all");
  const [actionsTarget, setActionsTarget] = useState<HTMLElement | null>(null);
  const [searchTarget, setSearchTarget] = useState<HTMLElement | null>(null);
  const [revision, setRevision] = useState(0);
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const [newType, setNewType] = useState<WorkflowType | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [legalQuantsOpen, setLegalQuantsOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<SkillCard | null>(null);
  const drafts = useWorkflowEditorStore((state) => state.drafts);
  const activeTab = useActivePanelTab(workflowsPanelKey(workspaceId));
  const panelOpen = useUiStateStore((state) => state.sidePanelState[workflowsPanelKey(workspaceId)] === "panel");
  const templateRun = useTemplateWorkflowRun();
  const allSkills = extensions.skills();
  const resources = extensions.skillResources();
  const resourceStatus = extensions.skillResourcesStatus();
  const contextKey = extensions.workspaceContextKey();
  const canEdit = props.canInstallSkillCreator;
  const installedNames = useMemo(() => new Set(allSkills.map((skill) => skill.name)), [allSkills]);
  const workflowSkills = allSkills.filter(skill => isWorkflowCard(skill)
    && (source === "all" || (source === "team" ? Boolean(skill.firm) : !skill.firm))
    // The team catalogue includes its installed and offered workflows once.
    && !(props.firmDownloadView && skill.firm));
  const localDrafts = Object.values(drafts).filter((draft) => draft.workspaceId === workspaceId);
  const newDrafts = localDrafts.filter((draft) => draft.isNew);
  const search = query.trim().toLowerCase();
  const matches = (name: string, description = "") => `${name} ${description}`.toLowerCase().includes(search);
  const filtered = workflowSkills.filter((skill) => {
    const draft = localDrafts.find((item) => item.name === skill.name && !item.isNew);
    return matches(draft?.title || workflowDisplayName(pluginImportSkillName(skill)), draft?.description ?? skill.description);
  });
  const filteredDrafts = source === "team" ? [] : newDrafts.filter((draft) => matches(draft.title, draft.description));
  const entries: { skill: SkillCard | null; draft: WorkflowDraft | undefined }[] = [
    ...filteredDrafts.map((draft) => ({ skill: null, draft })),
    ...filtered.map((skill) => ({ skill, draft: localDrafts.find((draft) => !draft.isNew && draft.name === skill.name) })),
  ];
  const lastPage = Math.max(0, Math.ceil(entries.length / WORKFLOWS_PER_PAGE) - 1);
  const currentPage = Math.min(page, lastPage);
  const visibleEntries = entries.slice(currentPage * WORKFLOWS_PER_PAGE, (currentPage + 1) * WORKFLOWS_PER_PAGE);

  useEffect(() => { setPage(0); }, [workspaceId]);
  // One of the firm's workflows, open to read.
  const [firmWorkflow, setFirmWorkflow] = useState<SkillCard | null>(null);
  // The firm's workflows change with its hub.
  useEffect(() => onSyncPoke((poke) => { if (poke.hub) void extensions.refreshSkills({ force: true }); }), [extensions]);
  useEffect(() => { setPage((value) => Math.min(value, lastPage)); }, [lastPage]);
  useEffect(() => { if (listRef.current) listRef.current.scrollTop = 0; }, [currentPage, source, query]);

  useEffect(() => bindWorkflowServices(workspaceId, {
    extensions, contextKey, currentContextKey: extensions.workspaceContextKey, canEdit, busy: props.busy, resources, resourceStatus,
  }), [workspaceId, extensions, contextKey, canEdit, props.busy, resources, resourceStatus]);

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

  const refresh = () => {
    setRevision(value => value + 1);
    if (section === "prompts") {
      void queryClient.invalidateQueries({ queryKey: ["review-library"] });
      return;
    }
    setRefreshing(true);
    void Promise.resolve(extensions.refreshSkills({ force: true })).finally(() => setRefreshing(false));
  };

  const start = (type: WorkflowType) => setNewType(type);
  const closeDraft = (id: string) => {
    discardWorkflow(id);
    const panels = usePanelTabStore.getState();
    for (const [sessionId, session] of Object.entries(panels.sessions)) {
      if (session.tabs.some((tab) => tab.id === id)) panels.closeTab(sessionId, id);
    }
  };
  const row = (skill: SkillCard | null, draft: WorkflowDraft | undefined) => {
    const name = draft?.title || (skill ? workflowDisplayName(pluginImportSkillName(skill)) : t("skills.new_workflow"));
    const description = draft?.description ?? skill?.description ?? "";
    const icon = <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-border"><Workflow className="size-4 text-muted-foreground" /></span>;
    // The firm's workflow follows its hub: members read it, but cannot change or remove it here.
    if (skill?.firm) {
      return <IntegrationLibraryRow key={skill.name} name={name} description={description} icon={icon} source={t("firm_hub.scope_team")} busy={props.busy} onOpen={() => setFirmWorkflow(skill)} />;
    }
    const selected = panelOpen && activeTab?.type === "workflow" && activeTab.id === draft?.id;
    const open = () => skill ? void openWorkflow(workspaceId, skill) : draft && showWorkflow(draft);
    const menuItems = (context: boolean) => {
      const Item = context ? ContextMenuItem : DropdownMenuItem;
      const Separator = context ? ContextMenuSeparator : DropdownMenuSeparator;
      return <>
        {skill ? <>
          <Item disabled={props.busy || !props.canUseDesktopTools} onClick={() => void extensions.exportSkillZip(skill.name).then((result) => { if (!result.ok) toast.error(result.message); else if (result.message) toast.success(result.message); })}><Download />{t("workflows.export")}</Item>
          {props.canShareWithFirm && props.onShareWithFirm ? <Item disabled={props.busy} onClick={() => void props.onShareWithFirm?.(skill.name, "workflow")}><Share2 />{t("workflows.share")}</Item> : null}
          <Separator />
          <Item variant="destructive" disabled={props.busy || !canEdit || draft?.saving} onClick={() => setRemoveTarget(skill)}><Trash2 />{t("skills.uninstall")}</Item>
        </> : draft ? <>
          <Separator />
          <Item variant="destructive" disabled={draft.saving} onClick={() => discardDocumentsThen(() => closeDraft(draft.id), draft.id)}><Trash2 />{t("workflows.discard_draft")}</Item>
        </> : null}
      </>;
    };
    return <ContextMenu key={draft?.id ?? skill?.name}>
      <ContextMenuTrigger render={<div />}>
        <IntegrationLibraryRow name={name} description={description} icon={icon} selected={selected} opensEditor busy={props.busy} onOpen={open} actions={menuItems(false)}
          status={draft?.isNew ? <span className="shrink-0 text-xs text-muted-foreground">{t("workflows.draft")}</span> : draft && workflowDirty(draft) ? <span aria-label={t("common.unsaved_changes")} className="size-1.5 shrink-0 rounded-full bg-foreground/60" /> : undefined} />
      </ContextMenuTrigger>
      <ContextMenuContent><ContextMenuItem onClick={open}><Pencil />{t("common.edit")}</ContextMenuItem>{menuItems(true)}</ContextMenuContent>
    </ContextMenu>;
  };

  const library = <section aria-label={t("skills.workflows_title")} className="@container/workflows flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-background">
    <IntegrationLibraryActions>
      <Button variant="outline" disabled={props.busy || !canEdit} onClick={() => setImportOpen(true)}><Download className="size-3.5" />{t("integrations.import_action")}</Button>
      <IntegrationAddMenu size="default" disabled={props.busy || !canEdit} actions={[
        { label: t("skills.new_workflow"), icon: Workflow, onClick: () => start("assistant") },
        ...(props.onGenerateFromTemplates ? [{ label: t("skills.generate_from_templates"), icon: Wand2, disabled: !props.canUseDesktopTools || templateRun?.status === "running", onClick: () => void generate() }] : []),
      ]} />
    </IntegrationLibraryActions>
    <IntegrationSearch toolbar value={query} onChange={value => { setQuery(value); setPage(0); }} label={t("workflows.search")} />
    {props.accessHint ? <p className="mb-4 text-xs text-muted-foreground">{props.accessHint}</p> : null}
      <div ref={listRef} className="min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain pb-4">
        {templateRun && source !== "team" ? <div className="mb-2"><TemplateGenerationRow status={templateRun.status} templatesDir={templateRun.templatesDir} error={templateRun.error} summary={templateRun.summary} onOpen={props.onOpenTemplateGenerationSession} onRetry={retryTemplateWorkflowImport} onDismiss={dismissTemplateWorkflowRun} /></div> : null}
        {visibleEntries.map(({ skill, draft }) => row(skill, draft))}
        {!entries.length && (source === "personal" || !props.firmDownloadView) ? <IntegrationEmptyState icon={refreshing ? Loader2 : Workflow} title={refreshing ? t("skills.loading") : query ? t("workflows.no_matches") : source === "team" ? t("firm_hub.empty_workflows") : t("skills.no_workflows")}
          action={!query && !refreshing && source !== "team" ? <Button variant="outline" size="sm" disabled={!canEdit} onClick={() => start("assistant")}><Plus />{t("skills.new_workflow")}</Button> : undefined} /> : null}
        <IntegrationLibrarySearchContext.Provider value={{ query, hasOtherResults: entries.length > 0 || refreshing }}>{props.firmDownloadView}</IntegrationLibrarySearchContext.Provider>
      </div>
      <WorkflowPagination page={currentPage} total={entries.length} onPageChange={setPage} />
    {newType ? <NewWorkflowDialog key={`${workspaceId}-${newType}`} workspaceId={workspaceId} type={newType} busy={props.busy || !canEdit} onClose={() => setNewType(null)} onCreated={(draft) => {
      setNewType(null);
      setSource("all");
      setQuery("");
      setPage(Math.floor((newDrafts.length + Math.max(0, extensions.skills().filter(isWorkflowCard).findIndex((skill) => skill.name === draft.name))) / WORKFLOWS_PER_PAGE));
      showWorkflow(draft);
    }} /> : null}
    <ImportSkillsButton open={importOpen} onOpenChange={setImportOpen} onImportLegalQuants={() => setLegalQuantsOpen(true)} pluginImports={props.pluginImports} asWorkflow busy={props.busy} canUseDesktopTools={props.canUseDesktopTools} existingNames={installedNames} extensions={extensions} onImported={() => { setSource("all"); setQuery(""); setPage(0); refresh(); }} />
    {firmWorkflow ? <FirmSkillDialog name={firmWorkflow.name} added={firmWorkflow.firm === "optional"} read={extensions.readFirmSkill} onClose={() => setFirmWorkflow(null)} /> : null}
    <LegalQuantsImportButton open={legalQuantsOpen} onOpenChange={setLegalQuantsOpen} busy={props.busy} existingNames={installedNames} extensions={extensions} className="hidden" />
    <ConfirmModal open={Boolean(removeTarget)} title={t("skills.uninstall_title")} message={t("skills.uninstall_warning").replace("{name}", removeTarget?.name ?? "")} confirmLabel={t("skills.uninstall")} cancelLabel={t("common.cancel")} confirmButtonVariant="destructive" onCancel={() => setRemoveTarget(null)} onConfirm={() => {
      const target = removeTarget; setRemoveTarget(null); if (!target) return;
      const draft = localDrafts.find((entry) => entry.name === target.name);
      const uninstall = () => { void Promise.resolve(extensions.uninstallSkill(target.name)).then(() => {
        if (!draft || extensions.skills().some((skill) => skill.name === target.name)) return;
        closeDraft(draft.id);
      }); };
      if (draft) discardDocumentsThen(uninstall, draft.id);
      else uninstall();
    }} />
  </section>;

  return <IntegrationLibraryLayoutContext.Provider value={{ actions: actionsTarget, search: searchTarget, source, revision, ownsMoreMenu: true, onRefresh: refresh }}>
    <WorkflowsWorkspace active={props.active} workspaceId={workspaceId} client={props.reviewClient}><IntegrationLibraryPage>
    <div className="@container/workflow-library flex min-h-0 w-full flex-1 flex-col gap-5 overflow-hidden">
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-4">
      <SectionHeading size="page" title={t("skills.workflows_title")} />
      <div className="flex max-w-full flex-wrap items-center gap-2">
        {props.onManagePlugins ? <Button variant="outline" onClick={props.onManagePlugins}>{t("catalog.manage_integrations")}<ArrowUpRight /></Button> : null}
        <div ref={setActionsTarget} className="flex flex-wrap items-center gap-2 empty:hidden" />
        <IntegrationMoreMenu pageToolbar busy={props.busy || refreshing} onRefresh={refresh}>
          {section !== "prompts" ?
            <DropdownMenuItem disabled={props.busy || !props.canUseDesktopTools} onClick={() => void extensions.revealSkillsFolder()}><FolderOpen />{t("skills.reveal_folder")}</DropdownMenuItem>
          : null}
        </IntegrationMoreMenu>
      </div>
    </header>
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border/70 pb-4">
      <HubTabs label={t("skills.workflows_title")} value={section} onChange={value => { setSection(value); props.onSectionChange?.(value); }} items={[
        { id: "workflows", label: t("skills.workflows_title"), icon: Workflow },
        { id: "prompts", label: t("catalog.review_prompts"), icon: BookOpen },
        { id: "skills", label: t("skills.title"), icon: Blocks },
      ]} />
      <div className="flex w-full min-w-0 items-center gap-2 @min-[720px]/workflow-library:w-auto">
        <div ref={setSearchTarget} className="h-9 min-w-0 flex-1 @min-[720px]/workflow-library:w-64 @min-[720px]/workflow-library:flex-none" />
        <IntegrationSourceFilter value={source} onChange={value => { setSource(value); setPage(0); }} />
      </div>
    </div>
    {section === "workflows" ? library : section === "skills" ? <div className="min-h-0 flex-1 overflow-y-auto"><HubScopeContext.Provider value="local"><SkillsView {...props} kind="skills" showHeader={false} firmDownloadView={props.firmSkillsView} /></HubScopeContext.Provider></div> : props.reviewClient && props.reviewWorkspaceId ? <ReviewPromptLibrary key={props.reviewWorkspaceId} client={props.reviewClient} workspaceId={props.reviewWorkspaceId} teamLibrary={props.firmReviewSetsView} onStartCreate={() => setSource("all")} onShareSet={props.canShareWithFirm && props.onShareReviewSet ? entry => props.onShareReviewSet?.(entry.id) : undefined} /> : <p className="text-sm text-muted-foreground">{t("projects.connecting")}</p>}
    </div>
  </IntegrationLibraryPage></WorkflowsWorkspace></IntegrationLibraryLayoutContext.Provider>;
}
